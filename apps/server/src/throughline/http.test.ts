import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { AuthSessionId, AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import { describe, it, expect } from "vite-plus/test";
import { EnvironmentAuth, ServerAuthMissingCredentialError } from "../auth/EnvironmentAuth.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "../orchestration-v2/RuntimePolicy.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { throughlineRouteLayer } from "./http.ts";

function handler(authorized: boolean) {
  const sql = NodeSqliteClient.layer({ filename: ":memory:" });
  const initialized = Layer.effectDiscard(runMigrations()).pipe(Layer.provideMerge(sql));
  const external = Layer.mergeAll(
    initialized,
    NodeServices.layer,
    NodeCrypto.layer,
    Layer.mock(EnvironmentAuth)({
      authenticateHttpRequest: () =>
        authorized
          ? Effect.succeed({
              sessionId: AuthSessionId.make("fixture"),
              subject: "fixture",
              method: "bearer-access-token",
              scopes: [AuthOrchestrationOperateScope],
            })
          : Effect.fail(new ServerAuthMissingCredentialError({})),
    }),
    Layer.mock(ProviderSessionManagerV2)({
      open: () => Effect.die("unknown thread must not open a provider"),
    }),
    Layer.mock(RuntimePolicyV2)({
      resolve: () => Effect.die("unknown thread must not resolve a provider"),
    }),
    Layer.mock(ProviderInstanceRegistry)({ getInstance: () => Effect.succeed(undefined) }),
  );
  return HttpRouter.toWebHandler(throughlineRouteLayer.pipe(Layer.provideMerge(external)), {
    disableLogger: true,
  });
}
describe("cold namespace HTTP composition", () => {
  it("constructs the actual namespace runtime and refuses an unknown thread without a provider", async () => {
    const { handler: request, dispose } = handler(true);
    try {
      const response = await request(
        new Request("http://fixture/throughline/threads/missing/rewind", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"messageId":"missing"}',
        }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "rewind_refused", reason: "rewind-failed" });
    } finally {
      await dispose();
    }
  });
  it("retains the authenticated refusal after startup recovery constructs", async () => {
    const { handler: request, dispose } = handler(false);
    try {
      const response = await request(
        new Request("http://fixture/throughline/threads/missing/rewind", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"messageId":"missing"}',
        }),
      );
      expect(response.status).toBe(401);
    } finally {
      await dispose();
    }
  });
});
