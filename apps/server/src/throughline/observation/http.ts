import { fillNativeTranscriptPath } from "./NativeTranscriptFill.ts";
import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";

const noStore = { "cache-control": "no-store" };
const authorize = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* Effect.exit(auth.authenticateHttpRequest(request));
  return Exit.isSuccess(session) && session.value.scopes.includes(AuthOrchestrationReadScope);
});
const unauthorized = () =>
  HttpServerResponse.jsonUnsafe({ error: "auth_required" }, { status: 401, headers: noStore });

const identityRoute = HttpRouter.add(
  "GET",
  "/throughline/threads/:threadId/identity",
  Effect.gen(function* () {
    if (!(yield* authorize)) return unauthorized();
    const params = yield* HttpRouter.params;
    const sql = yield* SqlClient.SqlClient;
    yield* fillNativeTranscriptPath(params.threadId!);
    const rows =
      yield* sql`SELECT provider_session_id AS "providerSessionId", native_session_id AS "nativeSessionId",
    native_transcript_path AS "nativeTranscriptPath" FROM throughline_thread_identity WHERE thread_id=${params.threadId}`;
    return HttpServerResponse.jsonUnsafe(
      rows[0] ?? { providerSessionId: null, nativeSessionId: null, nativeTranscriptPath: null },
      { headers: noStore },
    );
  }),
);
const observationRoute = HttpRouter.add(
  "GET",
  "/throughline/threads/:threadId/observations",
  Effect.gen(function* () {
    if (!(yield* authorize)) return unauthorized();
    const params = yield* HttpRouter.params;
    const sql = yield* SqlClient.SqlClient;
    const rows =
      yield* sql`SELECT run_id AS "runId", requested_model AS "requestedModel", answering_model AS "answeringModel",
    source,scope FROM throughline_run_observation WHERE thread_id=${params.threadId} ORDER BY rowid`;
    return HttpServerResponse.jsonUnsafe(rows, { headers: noStore });
  }),
);
export const observationRouteLayer = Layer.mergeAll(identityRoute, observationRoute);
