import { expect, it } from "vite-plus/test";
import { makeWsRpcTransport } from "./ws-rpc-transport.ts";

it("refuses the retired V1 WS transport before opening any network connection", async () => {
  await expect(
    makeWsRpcTransport({
      serverUrl: "not-a-url",
      bearerToken: "fixture",
      projectId: "p",
      instanceId: "i",
      model: "fixture",
    }),
  ).rejects.toThrow("legacy-ws-transport-retired");
});
