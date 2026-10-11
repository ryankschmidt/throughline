import { MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { PreparedConnection } from "../connection/model.ts";
import type { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";

export const PreviousRewindCut = Schema.Struct({
  recovery_state: Schema.Literals(["refused"]),
  refusal_reason: Schema.NullOr(Schema.String),
});
export class ExactMessageRewindHttpError extends Schema.TaggedError<ExactMessageRewindHttpError>()(
  "ExactMessageRewindHttpError",
  { reason: Schema.String, previous_cut: Schema.optional(PreviousRewindCut) },
) {}
export interface ExactMessageRewindHttpInput {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly fetch: typeof fetch;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
}
const Ack = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  previous_cut: Schema.optional(PreviousRewindCut),
});
const Refusal = Schema.Struct({
  error: Schema.Literals(["rewind_refused"]),
  reason: Schema.String,
  previous_cut: Schema.optional(PreviousRewindCut),
});
const encodeRequest = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ messageId: MessageId })),
);

/** Uses the owning environment's already-verified connection; never falls back to WS/file rollback. */
export const sendExactMessageRewind = Effect.fn("ThroughLine.sendExactMessageRewind")(function* (
  input: ExactMessageRewindHttpInput,
) {
  let rejectedAccessToken: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    let authorization = input.prepared.httpAuthorization;
    let origin = input.prepared.httpBaseUrl;
    if (authorization?._tag === "Dpop") {
      if (Option.isNone(input.remoteAuthorization) || Option.isNone(input.signer)) {
        return yield* new ExactMessageRewindHttpError({
          reason: "relay-authorization-unavailable",
        });
      }
      const current = yield* input.remoteAuthorization.value
        .authorizeDpopHttp({
          expectedEnvironmentId: input.prepared.environmentId,
          ...(rejectedAccessToken === undefined ? {} : { rejectedAccessToken }),
        })
        .pipe(
          Effect.mapError(
            () => new ExactMessageRewindHttpError({ reason: "relay-authorization-failed" }),
          ),
        );
      if (input.prepared.target._tag === "RelayConnectionTarget") origin = current.httpBaseUrl;
      authorization = current.httpAuthorization;
    }
    const url = new URL(
      `/throughline/threads/${encodeURIComponent(input.threadId)}/rewind`,
      origin,
    ).toString();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (authorization?._tag === "Bearer") headers.authorization = `Bearer ${authorization.token}`;
    if (authorization?._tag === "Dpop") {
      if (Option.isNone(input.signer))
        return yield* new ExactMessageRewindHttpError({ reason: "relay-signer-unavailable" });
      const proof = yield* input.signer.value
        .createProof({ method: "POST", url, accessToken: authorization.accessToken })
        .pipe(
          Effect.mapError(() => new ExactMessageRewindHttpError({ reason: "relay-proof-failed" })),
        );
      headers.authorization = `DPoP ${authorization.accessToken}`;
      headers.dpop = proof;
    }
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        input.fetch(url, {
          method: "POST",
          headers,
          credentials: authorization === null ? "include" : "omit",
          body: encodeRequest({ messageId: input.messageId }),
          signal,
        }),
      catch: () => new ExactMessageRewindHttpError({ reason: "transport" }),
    });
    if (response.status === 401 && authorization?._tag === "Dpop" && attempt === 0) {
      rejectedAccessToken = authorization.accessToken;
      continue;
    }
    if (!response.ok) {
      if (response.status === 409) {
        const body: unknown = yield* Effect.tryPromise({
          try: () => response.json(),
          catch: () => new ExactMessageRewindHttpError({ reason: "invalid-refusal" }),
        }).pipe(Effect.catch(() => Effect.succeed(null)));
        if (Schema.is(Refusal)(body))
          return yield* new ExactMessageRewindHttpError({
            reason: body.reason,
            ...(body.previous_cut === undefined ? {} : { previous_cut: body.previous_cut }),
          });
      }
      return yield* new ExactMessageRewindHttpError({ reason: `http-${response.status}` });
    }
    const body = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => new ExactMessageRewindHttpError({ reason: "invalid-acknowledgement" }),
    });
    const ack = yield* Schema.decodeUnknownEffect(Ack)(body).pipe(
      Effect.mapError(() => new ExactMessageRewindHttpError({ reason: "invalid-acknowledgement" })),
    );
    if (ack.threadId !== input.threadId || ack.messageId !== input.messageId)
      return yield* new ExactMessageRewindHttpError({ reason: "mismatched-acknowledgement" });
    return ack;
  }
  return yield* new ExactMessageRewindHttpError({ reason: "authorization-refused" });
});
