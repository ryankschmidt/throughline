import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  MessageId,
  ThreadId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentAuth, ServerAuthMissingCredentialError } from "../../auth/EnvironmentAuth.ts";
import { ExactMessageRewindV2, ExactMessageRewindError } from "./ExactMessageRewindV2.ts";
import { rewindRouteLayer } from "./http.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../../persistence/Migrations.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});
function fixture(
  scopes: ReadonlyArray<AuthEnvironmentScope> | "none",
  refused = false,
  recoveryReason?: string,
  cutState: "pending" | "recovered" | "refused" = "refused",
  recovering = false,
) {
  const execute = vi.fn((input: { threadId: ThreadId; messageId: MessageId }) =>
    refused
      ? Effect.fail(new ExactMessageRewindError({ reason: "intra-run-trim-not-supported" }))
      : Effect.succeed({ ...input, sequence: 2 }),
  );
  const database = NodeSqliteClient.layer({ filename: ":memory:" });
  const initialized = Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      if (recoveryReason)
        yield* sql`INSERT INTO throughline_rewind_cut (thread_id,provider_thread_id,native_session_id,resume_at,target_message_id,target_run_ordinal,source_tip_run_ordinal,source_tip_sequence,recovery_state,refusal_reason) VALUES ('thread','provider','native','cursor','selected',0,1,10,${cutState},${cutState === "refused" ? recoveryReason : null})`;
    }),
  ).pipe(Layer.provideMerge(database));
  const routes = rewindRouteLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        initialized,
        Layer.mock(EnvironmentAuth)({
          authenticateHttpRequest: () =>
            scopes === "none"
              ? Effect.fail(new ServerAuthMissingCredentialError({}))
              : Effect.succeed({
                  sessionId: AuthSessionId.make("session"),
                  subject: "fixture",
                  method: "bearer-access-token",
                  scopes,
                }),
        }),
        Layer.succeed(ExactMessageRewindV2, {
          execute,
          recoverPendingCuts: Effect.void,
          recoveryInProgress: () => Effect.succeed(recovering),
        } as ExactMessageRewindV2["Service"]),
      ),
    ),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  disposers.push(dispose);
  return {
    execute,
    request: (body: string, method = "POST") =>
      handler(
        new Request("http://fixture.test/throughline/threads/thread/rewind", {
          method,
          headers: { "content-type": "application/json" },
          ...(method === "POST" ? { body } : {}),
        }),
      ),
  };
}
describe("checkpoint-free rewind HTTP scope and input boundary", () => {
  it("requires authentication before executing", async () => {
    const f = fixture("none");
    expect((await f.request('{"messageId":"selected"}')).status).toBe(401);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("refuses read-only authorization", async () => {
    const f = fixture([AuthOrchestrationReadScope]);
    expect((await f.request('{"messageId":"selected"}')).status).toBe(403);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("acknowledges the same message and thread for an authorized operator", async () => {
    const f = fixture([AuthOrchestrationOperateScope]);
    const response = await f.request('{"messageId":"selected"}');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      threadId: "thread",
      messageId: "selected",
      sequence: 2,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("cannot turn file restore or checkpoint fields into a conversation cut", async () => {
    const f = fixture([AuthOrchestrationOperateScope]);
    expect(
      (await f.request('{"messageId":"selected","restoreFiles":true,"checkpointId":"file"}'))
        .status,
    ).toBe(400);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("returns a truthful safe refusal rather than an acknowledgment", async () => {
    const f = fixture([AuthOrchestrationOperateScope], true);
    const response = await f.request('{"messageId":"selected"}');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "rewind_refused",
      reason: "intra-run-trim-not-supported",
    });
  });
  it("does not expose a GET mutation door", async () => {
    const f = fixture([AuthOrchestrationOperateScope]);
    expect((await f.request("", "GET")).status).toBe(404);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("a refused row then POST with the same messageId executes against the live projection", async () => {
    const f = fixture([AuthOrchestrationOperateScope], false, "active-provider-changed");
    const response = await f.request('{"messageId":"selected"}');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      threadId: "thread",
      messageId: "selected",
      sequence: 2,
      previous_cut: { recovery_state: "refused", refusal_reason: "active-provider-changed" },
    });
    expect(f.execute).toHaveBeenCalledExactlyOnceWith({
      threadId: "thread",
      messageId: "selected",
    });
  });
  it("a refused row then POST with a different messageId executes against the live projection", async () => {
    const f = fixture([AuthOrchestrationOperateScope], false, "active-provider-changed");
    const response = await f.request('{"messageId":"different"}');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      messageId: "different",
      previous_cut: { recovery_state: "refused", refusal_reason: "active-provider-changed" },
    });
    expect(f.execute).toHaveBeenCalledExactlyOnceWith({
      threadId: "thread",
      messageId: "different",
    });
  });
  it("POST during startup recovery returns recovery-in-progress and does not execute", async () => {
    const f = fixture([AuthOrchestrationOperateScope], false, "pending", "pending", true);
    const response = await f.request('{"messageId":"selected"}');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "rewind_refused",
      reason: "recovery-in-progress",
    });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("a recovered-awaiting-reply row then POST executes for repeated rewind", async () => {
    const f = fixture([AuthOrchestrationOperateScope], false, "recovered", "recovered");
    const response = await f.request('{"messageId":"selected"}');
    expect(response.status).toBe(200);
    expect(f.execute).toHaveBeenCalledExactlyOnceWith({
      threadId: "thread",
      messageId: "selected",
    });
  });
  it("a new refusal retains the previous recovery reason in the response", async () => {
    const f = fixture([AuthOrchestrationOperateScope], true, "active-provider-changed");
    const response = await f.request('{"messageId":"selected"}');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "rewind_refused",
      reason: "intra-run-trim-not-supported",
      previous_cut: { recovery_state: "refused", refusal_reason: "active-provider-changed" },
    });
  });
});
