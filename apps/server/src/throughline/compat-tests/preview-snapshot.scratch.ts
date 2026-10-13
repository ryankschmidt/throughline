// @effect-diagnostics nodeBuiltinImport:off - isolated smoke fixture metadata/files.
// @effect-diagnostics globalFetch:off - loopback MCP client, not credential or usage access.
/** Real candidate browser + MCP snapshot/save pipeline. Auth/thread fixtures are NOT admission proof. */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as NodeHttp from "node:http";
import { EnvironmentId, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import * as Config from "../../config.ts";
import * as Secrets from "../../auth/ServerSecretStore.ts";
import * as Environment from "../../environment/ServerEnvironment.ts";
import * as Manager from "../../preview/Manager.ts";
import * as Channel from "../../preview/DesktopBrowserChannel.ts";
import * as Browser from "../../preview/ServerBrowser.ts";
import * as BrowserInstall from "../../preview/PreviewBrowser.ts";
import * as Broker from "../../mcp/PreviewAutomationBroker.ts";
import * as Mcp from "../../mcp/McpHttpServer.ts";
import * as Registry from "../../mcp/McpSessionRegistry.ts";
import * as AccessFixture from "../../mcp/McpToolAccess.testkit.ts";
import { McpSchema, type McpServer } from "effect/ai";

const evidenceRoot =
  "/Users/Admin/core-root/vault/01_Projects/workbench/infra/throughline/plans/next-gen-spec-2026-10-07/execution/phase-04/preview-screenshot-20261012";
const scratchParent = "/Users/Admin/.local/state/throughline-upgrade-scratch";
export function assertReadablePng(bytes: Uint8Array) {
  const png = Buffer.from(bytes);
  if (
    png.length < 33 ||
    !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    png.toString("ascii", 12, 16) !== "IHDR" ||
    png.readUInt32BE(16) <= 0 ||
    png.readUInt32BE(20) <= 0
  )
    throw Error("Snapshot did not contain a PNG with nonzero dimensions.");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
const decodeCall = Schema.decodeUnknownSync(McpSchema.CallToolResult);
const decodeStatus = Schema.decodeUnknownSync(
  Schema.Struct({ url: Schema.String, tabId: Schema.String }),
);
const decodeSaved = Schema.decodeUnknownSync(
  Schema.Struct({ url: Schema.String, screenshotPath: Schema.String }),
);
const decodeEnvelope = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      result: Schema.optionalKey(Schema.Unknown),
      error: Schema.optionalKey(Schema.Unknown),
    }),
  ),
);
const unwrap = (value: unknown) =>
  typeof value === "object" && value !== null && "result" in value ? value.result : value;
const structured = (value: typeof McpSchema.CallToolResult.Type) =>
  value.structuredContent ??
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(
    value.content.find((c) => c.type === "text")?.text ?? "null",
  );
async function requestRpc(
  url: string,
  token: string,
  state: { session: string | null; id: number },
  method: string,
  params: unknown,
) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(state.session ? { "mcp-session-id": state.session } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++state.id, method, params }),
  });
  state.session ??= response.headers.get("mcp-session-id");
  const text = await response.text();
  const record = decodeEnvelope(
    text.startsWith("data:") || text.includes("\ndata:")
      ? text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .at(-1)!
          .slice(5)
      : text,
  );
  if (!response.ok || record.error)
    throw Error(`Scratch MCP request failed (${response.status}, ${method}).`);
  return record.result;
}

export async function runPreviewSnapshotScratch(mcpServerLayer: Layer.Layer<McpServer.McpServer>) {
  const evidence = NodePath.join(evidenceRoot, `run-${NodeCrypto.randomUUID().slice(0, 8)}`);
  await NodeFSP.mkdir(evidence, { recursive: true });
  const base = await NodeFSP.mkdtemp(NodePath.join(scratchParent, "preview-candidate-"));
  const token = NodeCrypto.randomUUID(); // Fixture-only capability, never logged.
  const invocation = {
    environmentId: EnvironmentId.make("environment-preview-scratch"),
    requestNamespace: "provider-session-preview-scratch",
    thread: {
      threadId: ThreadId.make("thread-preview-scratch"),
      providerSessionId: "provider-session-preview-scratch",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set(["preview"] as const),
    issuedAt: 1,
  };
  const config = Config.layerTest(base, base).pipe(Layer.provide(NodeServices.layer));
  const environment = Environment.layer.pipe(Layer.provide(Secrets.layer));
  const browserDependencies = Layer.mergeAll(
    Manager.layer,
    Broker.layer,
    Channel.layer,
    BrowserInstall.layer,
    environment,
  );
  const browser = Browser.layer.pipe(Layer.provideMerge(browserDependencies));
  const registration = Mcp.layerPreviewToolkit.pipe(
    Layer.provideMerge(mcpServerLayer),
    Layer.provide(AccessFixture.liveThreadsLayer),
  );
  // Only credential admission is a fixture port. All browser, snapshot, save and transport I/O is stock.
  const transport = Mcp.layerMcpTransport.pipe(
    Layer.provide(
      Layer.mock(Registry.McpSessionRegistry)({
        resolve: (presented) => Effect.succeed(presented === token ? invocation : undefined),
      }),
    ),
  );
  const runtime = registration.pipe(
    Layer.provideMerge(browser),
    Layer.provideMerge(config),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(NodeServices.layer),
  );
  const layers = HttpRouter.serve(transport, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provideMerge(runtime),
    Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 })),
    Layer.provideMerge(NodeServices.layer),
  );
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Layer.build(layers);
        invocation.environmentId = yield* Context.get(services, Environment.ServerEnvironment)
          .getEnvironmentId;
        const address = Context.get(services, HttpServer.HttpServer).address;
        if (address._tag !== "InetAddressV4") throw Error("Scratch server must use isolated IPv4.");
        const url = `http://127.0.0.1:${address.port}/mcp`;
        return yield* Effect.tryPromise(async () => {
          const state: { session: string | null; id: number } = { session: null, id: 0 };
          const rpc = (method: string, params: unknown) =>
            requestRpc(url, token, state, method, params);
          await rpc("initialize", {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "preview-scratch", version: "1" },
          });
          const open = decodeCall(
            await rpc("tools/call", {
              name: "preview_open",
              arguments: { url: "https://example.com", open: true, show: true },
            }),
          );
          if (open.isError)
            throw Error(
              "Candidate preview_open refused; retained result is not a screenshot pass.",
            );
          const openValue = decodeStatus(unwrap(structured(open)));
          const pixels = decodeCall(
            await rpc("tools/call", {
              name: "preview_snapshot",
              arguments: { tabId: openValue.tabId, includeImage: true },
            }),
          );
          if (pixels.isError) throw Error("Candidate snapshot failed.");
          const image = pixels.content.find((c) => c.type === "image");
          if (!image || image.mimeType !== "image/png")
            throw Error("Snapshot did not return PNG pixels.");
          const bytes = Buffer.from(image.data);
          const dimensions = assertReadablePng(bytes);
          if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
            throw Error("Image is not a PNG.");
          const save = decodeCall(
            await rpc("tools/call", {
              name: "preview_snapshot",
              arguments: { tabId: openValue.tabId, save: true },
            }),
          );
          if (save.isError) throw Error("Candidate save:true failed.");
          const saved = decodeSaved(structured(save));
          const savedBytes = await NodeFSP.readFile(saved.screenshotPath);
          assertReadablePng(savedBytes);
          const png = NodePath.join(evidence, "Candidate-External-Page.png");
          await NodeFSP.copyFile(saved.screenshotPath, png);
          return {
            externalUrl: openValue.url,
            tabId: openValue.tabId,
            imageBytes: bytes.length,
            ...dimensions,
            savedPath: saved.screenshotPath,
            evidencePng: png,
            savedBytes: savedBytes.length,
            savedSha256: NodeCrypto.createHash("sha256").update(savedBytes).digest("hex"),
            proofLimit:
              "Real browser/MCP pixels and save path; auth/thread fixture ports, not full admission/installed product acceptance.",
          };
        });
      }),
    ),
  );
  await NodeFSP.writeFile(
    NodePath.join(evidence, "Candidate-Reproduction.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  return result;
}
