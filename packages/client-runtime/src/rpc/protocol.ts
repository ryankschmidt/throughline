import { WsRpcGroup, WsThroughlineHelloRpc } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { RpcClient } from "effect/rpc";

export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup);
type RpcClientFactory = typeof makeWsRpcProtocolClient;
export type WsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;

export function clientHelloFromMetadata(
  metadata: {
    readonly release?: string | undefined;
    readonly platform?: string | undefined;
    readonly commit?: string | null | undefined;
  },
  capabilities: ReadonlyArray<string>,
): typeof WsThroughlineHelloRpc.payloadSchema.Type | undefined {
  if (!metadata.release?.trim() || !metadata.platform?.trim()) return undefined;
  return {
    protocol_version: 1,
    release: metadata.release,
    platform: metadata.platform,
    commit: metadata.commit ?? null,
    capabilities,
    // Hello does not take ownership of existing per-subscription replay cursors.
    last_cursor: null,
  };
}
// Pings go out every 5 seconds, and a server busy for a few seconds stops
// answering them. Allow 15 seconds without any frame before dropping the socket.
export const PING_TIMEOUT = "15 seconds";
