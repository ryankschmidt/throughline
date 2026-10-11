import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import { afterEach, expect, it } from "vite-plus/test";
import * as Auth from "../../auth/EnvironmentAuth.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { headroomRouteLayer } from "./http.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});
const fixture = (scopes: readonly AuthEnvironmentScope[] | "none") => {
  const routes = headroomRouteLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Sqlite.layerMemory,
        Layer.mock(Auth.EnvironmentAuth)({
          authenticateHttpRequest: () =>
            scopes === "none"
              ? Effect.fail(new Auth.ServerAuthMissingCredentialError({}))
              : Effect.succeed({
                  sessionId: AuthSessionId.make("fixture"),
                  subject: "fixture",
                  method: "bearer-access-token",
                  scopes,
                }),
        }),
      ),
    ),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  disposers.push(dispose);
  return (method = "GET") =>
    handler(new Request("http://fixture/throughline/threads/thread/headroom", { method }));
};
it("requires authentication before reading headroom", async () => {
  expect((await fixture("none")()).status).toBe(401);
});
it("requires orchestration read scope even for an operate-only token", async () => {
  expect((await fixture([AuthOrchestrationOperateScope])()).status).toBe(403);
});
it("returns no recorded wait without claiming quota availability, and disables caching", async () => {
  const response = await fixture([AuthOrchestrationReadScope])();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ waits: [] });
  expect(response.headers.get("cache-control")).toBe("no-store");
});
it("has no POST mutation door", async () => {
  expect((await fixture([AuthOrchestrationReadScope])("POST")).status).toBe(404);
});
