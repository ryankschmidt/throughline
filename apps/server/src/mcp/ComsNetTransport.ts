import { fillNativeTranscriptPath } from "../throughline/observation/NativeTranscriptFill.ts";
import {
  ComsNetError,
  JsonFileComsNetStore,
  type PeerDirectory,
  type PeerIdentity,
  type SendInput,
  type WaitForResultOptions,
} from "@ryan/agent-mcp-relay";
import {
  ReceiverTurnRelay as ComsNet,
  type ReceiverTurnRequest as ComsNetRequest,
  type ReceiverTurnSubscribeOptions as SubscribeOptions,
} from "../throughline/legacyRelay.ts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../config.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as SqlClient from "effect/sql/SqlClient";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as McpProviderSession from "@t3tools/provider-core/server/McpProviderSessions";

export const COMSNET_REQUEST_LEASE_MS = 120_000;

export interface ComsNetTransportShape {
  readonly listPeers: () => Effect.Effect<ReadonlyArray<PeerIdentity>, ComsNetTransportError>;
  readonly send: (
    scope: McpInvocationScope,
    input: SendInput,
  ) => Effect.Effect<ComsNetRequest, ComsNetTransportError>;
  readonly subscribe: (
    scope: McpInvocationScope,
    options?: SubscribeOptions,
  ) => Effect.Effect<ReadonlyArray<ComsNetRequest>, ComsNetTransportError>;
  readonly status: (
    scope: McpInvocationScope,
    requestId: string,
  ) => Effect.Effect<ComsNetRequest, ComsNetTransportError>;
  readonly complete: (
    scope: McpInvocationScope,
    requestId: string,
    result: unknown,
  ) => Effect.Effect<ComsNetRequest, ComsNetTransportError>;
  readonly failDispatch: (
    scope: McpInvocationScope,
    requestId: string,
    error: string,
  ) => Effect.Effect<ComsNetRequest, ComsNetTransportError>;
  readonly markDispatchSucceeded: (
    scope: McpInvocationScope,
    requestId: string,
  ) => Effect.Effect<ComsNetRequest, ComsNetTransportError>;
  readonly waitForResult: (
    scope: McpInvocationScope,
    requestId: string,
    options?: WaitForResultOptions,
  ) => Effect.Effect<ComsNetRequest, ComsNetTransportError>;
  readonly listFinishedTurnRequests: (
    receiverThreadId: string,
    receiverTurnId: string,
  ) => Effect.Effect<ReadonlyArray<ComsNetRequest>, ComsNetTransportError>;
  readonly completeFinishedTurn: (
    receiverThreadId: string,
    requestId: string,
    result: unknown,
  ) => Effect.Effect<ComsNetRequest, ComsNetTransportError>;
  readonly failFinishedTurn: (
    receiverThreadId: string,
    requestId: string,
    error: string,
  ) => Effect.Effect<ComsNetRequest, ComsNetTransportError>;
  readonly sweepExpired: () => Effect.Effect<ReadonlyArray<ComsNetRequest>, ComsNetTransportError>;
}

export class ComsNetTransportError extends Data.TaggedError("ComsNetTransportError")<{
  readonly message: string;
  readonly code?: string;
  readonly cause?: unknown;
}> {}

export class ComsNetTransport extends Context.Service<ComsNetTransport, ComsNetTransportShape>()(
  "t3/mcp/ComsNetTransport",
) {}

const fromPromise = <A>(operation: () => Promise<A>): Effect.Effect<A, ComsNetTransportError> =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      new ComsNetTransportError({
        message: cause instanceof Error ? cause.message : String(cause),
        ...(cause instanceof ComsNetError ? { code: cause.code } : {}),
        cause,
      }),
  });

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const mcpSessions = yield* McpProviderSession.McpProviderSessions;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sql = yield* SqlClient.SqlClient;
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);

  const peers: PeerDirectory = {
    list: async () => {
      const snapshot = await runPromise(threads.getShellSnapshot());
      const projectRows = await runPromise(projects.listShells());
      const workspaceByProject = new Map(
        projectRows.map((project) => [project.id, project.workspaceRoot] as const),
      );
      const identities: Array<PeerIdentity> = [];
      for (const thread of snapshot.threads) {
        const mcpSession = await runPromise(mcpSessions.read(thread.id));
        if (mcpSession === undefined) continue;
        const instance = await runPromise(instances.getInstance(mcpSession.providerInstanceId));
        if (instance === undefined) continue;
        const cwd = thread.worktreePath ?? workspaceByProject.get(thread.projectId);
        if (cwd === undefined) continue;
        await runPromise(
          fillNativeTranscriptPath(thread.id).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
        );
        const native = await runPromise(
          sql<{
            native_transcript_path: string | null;
          }>`SELECT native_transcript_path FROM throughline_thread_identity WHERE thread_id=${thread.id}`,
        );
        identities.push({
          peerId: `${instance.driverKind}:${mcpSession.providerSessionId}`,
          threadId: thread.id,
          providerName: instance.driverKind,
          providerInstanceId: mcpSession.providerInstanceId,
          providerSessionId: mcpSession.providerSessionId,
          ...(native[0]?.native_transcript_path
            ? { transcriptPath: native[0].native_transcript_path }
            : {}),
          cwd,
        });
      }
      return identities;
    },
    get: async (peerId) => (await peers.list()).find((peer) => peer.peerId === peerId),
  };

  const network = new ComsNet({
    store: new JsonFileComsNetStore(`${config.stateDir}/coms-net/requests.json`),
    peers,
    maxPayloadBytes: 64 * 1024,
    deliveryLeaseMs: 30_000,
    requestLeaseMs: COMSNET_REQUEST_LEASE_MS,
    receiverTurnLeaseMs: 4 * 60 * 60_000,
  });

  const principalFor = (scope: McpInvocationScope) =>
    fromPromise(async () => {
      const principal = (await peers.list()).find(
        (peer) =>
          peer.threadId === scope.thread?.threadId &&
          peer.providerSessionId === scope.thread?.providerSessionId &&
          peer.providerInstanceId === scope.thread?.providerInstanceId,
      );
      if (principal === undefined) {
        throw new ComsNetTransportError({
          message: "MCP credential does not resolve to a current ThroughLine peer",
        });
      }
      return principal;
    });

  return ComsNetTransport.of({
    listPeers: () => fromPromise(() => network.listPeers()),
    send: (scope, input) =>
      Effect.flatMap(principalFor(scope), (principal) =>
        fromPromise(() => network.send(principal, input)),
      ),
    subscribe: (scope, options) =>
      Effect.flatMap(principalFor(scope), (principal) =>
        fromPromise(() => network.subscribe(principal, options)),
      ),
    status: (scope, requestId) =>
      Effect.flatMap(principalFor(scope), (principal) =>
        fromPromise(() => network.status(principal, requestId)),
      ),
    complete: (scope, requestId, result) =>
      Effect.flatMap(principalFor(scope), (principal) =>
        fromPromise(() => network.complete(principal, requestId, result)),
      ),
    failDispatch: (scope, requestId, error) =>
      Effect.flatMap(principalFor(scope), (principal) =>
        fromPromise(() => network.failDispatch(principal, requestId, error)),
      ),
    markDispatchSucceeded: (scope, requestId) =>
      Effect.flatMap(principalFor(scope), (principal) =>
        fromPromise(() => network.markDispatchSucceeded(principal, requestId)),
      ),
    waitForResult: (scope, requestId, options) =>
      Effect.flatMap(principalFor(scope), (principal) =>
        fromPromise(() => network.waitForResult(principal, requestId, options)),
      ),
    listFinishedTurnRequests: (receiverThreadId, receiverTurnId) =>
      fromPromise(() => network.listTrustedReceiverTurn(receiverThreadId, receiverTurnId)),
    completeFinishedTurn: (receiverThreadId, requestId, result) =>
      fromPromise(() => network.completeTrustedReceiverThread(receiverThreadId, requestId, result)),
    failFinishedTurn: (receiverThreadId, requestId, error) =>
      fromPromise(() => network.failTrustedReceiverThread(receiverThreadId, requestId, error)),
    sweepExpired: () => fromPromise(() => network.sweepExpiredRequests()),
  });
});

export const layer = Layer.effect(ComsNetTransport, make);
