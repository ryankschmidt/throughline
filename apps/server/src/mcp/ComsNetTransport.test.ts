import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../config.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Instances from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as McpProviderSession from "@t3tools/provider-core/server/McpProviderSessions";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as SqlClient from "effect/sql/SqlClient";
import { ComsNetTransport, layer as ComsNetTransportLive } from "./ComsNetTransport.ts";

const providerInstanceId = ProviderInstanceId.make("codex-instance");
const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");

const snapshot = {
  projects: [
    {
      id: ProjectId.make("project-a"),
      workspaceRoot: "/workspace/project-a",
    },
  ],
  threads: [
    {
      id: threadA,
      projectId: ProjectId.make("project-a"),
      worktreePath: null,
      session: {
        status: "running",
        providerName: "codex",
        providerInstanceId,
        // The native provider thread id and transcript are not the MCP
        // credential identity. A newly-started real Codex turn can project
        // neither while its MCP credential is already live.
        providerSessionId: null,
        nativeTranscriptPath: null,
      },
    },
    {
      id: threadB,
      projectId: ProjectId.make("project-a"),
      worktreePath: null,
      session: {
        status: "running",
        providerName: "codex",
        providerInstanceId,
        providerSessionId: "native-codex-thread-b",
        nativeTranscriptPath: "/native/codex-thread-b.jsonl",
      },
    },
  ],
} as unknown as OrchestrationV2ShellSnapshot;

const TestLayer = ComsNetTransportLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.mock(Threads.ThreadManagementService)({
        getShellSnapshot: () => Effect.succeed(snapshot),
      }),
      Layer.mock(Projects.ProjectStoreV2)({
        listShells: () =>
          Effect.succeed([
            {
              id: ProjectId.make("project-a"),
              title: "Project A",
              workspaceRoot: "/workspace/project-a",
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-10-11T00:00:00Z",
              updatedAt: "2026-10-11T00:00:00Z",
            },
          ]),
      }),
      Layer.mock(Instances.ProviderInstanceRegistry)({
        getInstance: () => Effect.succeed({ driverKind: "codex" } as ProviderInstance),
      }),
      McpProviderSession.layer,
      Sqlite.layerMemory,
    ),
  ),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-comsnet-live-peer-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(TestLayer)("ComsNetTransport real provider lifecycle join", (it) => {
  it.effect(
    "uses active server-issued MCP sessions for roster identity and caller resolution",
    () =>
      Effect.acquireUseRelease(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO throughline_thread_identity (thread_id,provider_thread_id,provider_session_id,native_transcript_path) VALUES ('thread-b','provider-thread-b','native-codex-thread-b','/native/codex-thread-b.jsonl')`;
          const sessions = yield* McpProviderSession.McpProviderSessions;
          yield* sessions.set({
            environmentId: EnvironmentId.make("environment-a"),
            threadId: threadA,
            providerSessionId: "mcp-session-a",
            providerInstanceId,
            endpoint: "http://127.0.0.1:3773/mcp",
            authorizationHeader: "Bearer token-a",
            capabilities: new Set(["comsnet"]),
            browserToolsAvailable: false,
          });
          yield* sessions.set({
            environmentId: EnvironmentId.make("environment-a"),
            threadId: threadB,
            providerSessionId: "mcp-session-b",
            providerInstanceId,
            endpoint: "http://127.0.0.1:3773/mcp",
            authorizationHeader: "Bearer token-b",
            capabilities: new Set(["comsnet"]),
            browserToolsAvailable: false,
          });
        }),
        () =>
          Effect.gen(function* () {
            const transport = yield* ComsNetTransport;
            const peers = yield* transport.listPeers();

            assert.deepEqual(
              peers.map((peer) => ({
                peerId: peer.peerId,
                threadId: peer.threadId,
                providerSessionId: peer.providerSessionId,
                transcriptPath: peer.transcriptPath,
              })),
              [
                {
                  peerId: "codex:mcp-session-a",
                  threadId: "thread-a",
                  providerSessionId: "mcp-session-a",
                  transcriptPath: undefined,
                },
                {
                  peerId: "codex:mcp-session-b",
                  threadId: "thread-b",
                  providerSessionId: "mcp-session-b",
                  transcriptPath: "/native/codex-thread-b.jsonl",
                },
              ],
            );

            const requests = yield* transport.subscribe(
              {
                environmentId: EnvironmentId.make("environment-a"),
                thread: {
                  threadId: threadA,
                  providerSessionId: "mcp-session-a",
                  providerInstanceId,
                },
                requestNamespace: "test-comsnet",
                client: undefined,
                capabilities: new Set(["comsnet"]),
                issuedAt: 0,
              },
              { timeoutMs: 1 },
            );
            assert.deepEqual(requests, []);
          }),
        () =>
          Effect.gen(function* () {
            const sessions = yield* McpProviderSession.McpProviderSessions;
            yield* sessions.clear(threadA);
            yield* sessions.clear(threadB);
          }),
      ),
  );
});
