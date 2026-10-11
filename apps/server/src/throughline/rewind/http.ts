import { AuthOrchestrationOperateScope, MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { EnvironmentAuth } from "../../auth/EnvironmentAuth.ts";
import { ExactMessageRewindV2 } from "./ExactMessageRewindV2.ts";

export const EXACT_MESSAGE_REWIND_ROUTE = "/throughline/threads/:threadId/rewind";
const RequestBody = Schema.Struct({ messageId: MessageId });
const noStore = { "cache-control": "no-store" };
const rewindHandler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const auth = yield* EnvironmentAuth;
  const session = yield* Effect.exit(auth.authenticateHttpRequest(request));
  if (Exit.isFailure(session))
    return HttpServerResponse.jsonUnsafe(
      { error: "auth_required" },
      { status: 401, headers: noStore },
    );
  if (!session.value.scopes.includes(AuthOrchestrationOperateScope))
    return HttpServerResponse.jsonUnsafe(
      { error: "scope_required", requiredScope: AuthOrchestrationOperateScope },
      { status: 403, headers: noStore },
    );
  const params = yield* HttpRouter.params;
  const body = yield* Effect.exit(
    request.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(RequestBody, { onExcessProperty: "error" })),
    ),
  );
  if (Exit.isFailure(body) || !params.threadId?.trim())
    return HttpServerResponse.jsonUnsafe(
      { error: "invalid_rewind_request" },
      { status: 400, headers: noStore },
    );
  const sql = yield* SqlClient.SqlClient;
  const cuts = yield* sql<{
    recovery_state: "pending" | "recovered" | "refused";
    refusal_reason: string | null;
  }>`SELECT recovery_state,refusal_reason FROM throughline_rewind_cut WHERE thread_id=${params.threadId} AND committed_at IS NULL`;
  const service = yield* ExactMessageRewindV2;
  const threadId = ThreadId.make(params.threadId);
  if (cuts[0]?.recovery_state === "pending" && (yield* service.recoveryInProgress(threadId)))
    return HttpServerResponse.jsonUnsafe(
      { error: "rewind_refused", reason: "recovery-in-progress" },
      { status: 409, headers: noStore },
    );
  const previous = cuts[0]?.recovery_state === "refused" ? { previous_cut: cuts[0] } : {};
  const logReplacement = (reason: string | null) =>
    cuts[0]?.recovery_state === "refused"
      ? Effect.logInfo("ThroughLine refused rewind cut replacement", {
          threadId,
          previousReason: cuts[0].refusal_reason,
          newReason: reason,
        })
      : Effect.void;
  return yield* service.execute({ threadId, messageId: body.value.messageId }).pipe(
    Effect.tap(() => logReplacement(null)),
    Effect.map((ack) =>
      HttpServerResponse.jsonUnsafe({ ...ack, ...previous }, { headers: noStore }),
    ),
    Effect.catch((error) =>
      logReplacement(error.reason).pipe(
        Effect.as(
          HttpServerResponse.jsonUnsafe(
            { error: "rewind_refused", reason: error.reason, ...previous },
            { status: 409, headers: noStore },
          ),
        ),
      ),
    ),
  );
});

// Capture the namespace service at route construction. HttpRouter's request
// requirement markers are not removed by ordinary Layer.provide.
export const rewindRouteLayer = Layer.unwrap(
  Effect.map(ExactMessageRewindV2, (service) =>
    HttpRouter.add(
      "POST",
      EXACT_MESSAGE_REWIND_ROUTE,
      rewindHandler.pipe(Effect.provideService(ExactMessageRewindV2, service)),
    ),
  ),
);

/** Pending cuts are replayed before the namespace accepts another conversation command. */
export const recoveryLayer = Layer.effectDiscard(
  Effect.flatMap(ExactMessageRewindV2, (service) => service.recoverPendingCuts),
);
