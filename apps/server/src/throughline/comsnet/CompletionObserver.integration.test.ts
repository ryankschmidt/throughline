import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  OrchestrationV2StoredEventJson,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as McpSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerConfig } from "../../config.ts";
import * as Transport from "../../mcp/ComsNetTransport.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import * as Instances from "../../provider/ProviderInstanceRegistry.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ProjectionObservation from "../observation/ProjectionObservation.ts";
import { observeCommittedRuns } from "./CompletionObserver.ts";

const at = "2026-10-11T12:00:00.000Z";
const senderThread = ThreadId.make("correlation-sender");
const receiverThread = ThreadId.make("correlation-receiver");
const instance = ProviderInstanceId.make("fixture-codex");
const scope = (threadId: ThreadId): McpInvocationScope => ({
  environmentId: EnvironmentId.make("fixture-environment"),
  thread: { threadId, providerInstanceId: instance, providerSessionId: `mcp-${threadId}` },
  client: undefined,
  capabilities: new Set(["comsnet"]),
  requestNamespace: "fixture",
  issuedAt: 0,
});
const event = (type: string, payload: unknown, id: string, threadId = receiverThread) =>
  Schema.decodeUnknownSync(OrchestrationV2StoredEventJson)({
    sequence: 1,
    commandId: null,
    event: { id, type, threadId, occurredAt: at, payload },
  }).event;
const threadEvent = (id: ThreadId) =>
  event(
    "thread.created",
    {
      id,
      projectId: "project",
      title: "Correlation fixture",
      providerInstanceId: instance,
      modelSelection: { instanceId: instance, model: "fixture-model" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: "/fixture",
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    `create-${id}`,
    id,
  );
const runPayload = (id: string, status: string, ordinal: number) => ({
  id,
  threadId: receiverThread,
  ordinal,
  providerInstanceId: instance,
  modelSelection: { instanceId: instance, model: "fixture-model" },
  providerThreadId: null,
  userMessageId: `user-${id}`,
  rootNodeId: `root-${id}`,
  activeAttemptId: null,
  status,
  requestedAt: at,
  startedAt: at,
  completedAt: status === "running" ? null : at,
  checkpointId: null,
  contextHandoffId: null,
});
const message = (
  runId: string,
  role: "user" | "assistant",
  text: string,
  nodeId: string | null,
  suffix: string = role,
) =>
  event(
    "message.updated",
    {
      id: `${suffix}-${runId}`,
      threadId: receiverThread,
      runId,
      nodeId,
      role,
      text,
      attachments: [],
      streaming: false,
      createdAt: at,
      updatedAt: at,
      createdBy: role === "user" ? "user" : "agent",
      creationSource: "mcp",
    },
    `message-${suffix}-${runId}`,
  );

const runtime = (file: string, ready: Deferred.Deferred<void>) => {
  const stores = Layer.mergeAll(
    EventStore.layer,
    ProjectionObservation.layer.pipe(Layer.provide(ProjectionStore.layer)),
  ).pipe(Layer.provideMerge(Sqlite.layerFromPath(file)));
  const witness = Layer.effect(
    EventStore.EventStoreV2,
    Effect.gen(function* () {
      const base = yield* EventStore.EventStoreV2;
      return {
        ...base,
        latestSequence: (input) =>
          base.latestSequence(input).pipe(Effect.tap(() => Deferred.succeed(ready, undefined))),
      };
    }),
  ).pipe(Layer.provide(stores));
  const sink = EventSink.layer.pipe(Layer.provide(witness), Layer.provideMerge(stores));
  const threads = Layer.unwrap(
    Effect.gen(function* () {
      const projection = yield* ProjectionStore.ProjectionStoreV2;
      return Layer.mock(Threads.ThreadManagementService)({
        // Provider identity is an external fixture; projection reads are real SQL.
        getThreadRecords: (id, fields, filter) =>
          projection
            .getThreadRecords(id, fields, filter)
            .pipe(
              Effect.mapError(
                (cause) => new Orchestrator.OrchestratorProjectionError({ threadId: id, cause }),
              ),
            ),
        getShellSnapshot: () =>
          projection
            .getShellSnapshot()
            .pipe(
              Effect.mapError(
                (cause) =>
                  new Orchestrator.OrchestratorProjectionError({ threadId: receiverThread, cause }),
              ),
            ),
      });
    }),
  ).pipe(Layer.provide(stores));
  const transport = Transport.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        threads,
        sink,
        stores,
        McpSessions.layer,
        Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
        Layer.mock(Instances.ProviderInstanceRegistry)({
          getInstance: () => Effect.succeed({ driverKind: "codex" } as ProviderInstance),
        }),
      ),
    ),
  );
  return transport;
};
const setFixtureSessions = Effect.gen(function* () {
  const sessions = yield* McpSessions.McpProviderSessions;
  for (const threadId of [senderThread, receiverThread])
    yield* sessions.set({
      environmentId: EnvironmentId.make("fixture-environment"),
      threadId,
      providerInstanceId: instance,
      providerSessionId: `mcp-${threadId}`,
      endpoint: "http://127.0.0.1:1/mcp",
      authorizationHeader: "Bearer fixture-only",
      capabilities: new Set(["comsnet"]),
      browserToolsAvailable: false,
    });
});
const fixture = <A, E, R>(
  body: (file: string, ready: Deferred.Deferred<void>) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem,
        path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "throughline-comsnet-sql-" });
      const file = path.join(directory, "state.sqlite"),
        ready = yield* Deferred.make<void>();
      return yield* Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        yield* sink.write({ events: [threadEvent(senderThread), threadEvent(receiverThread)] });
        yield* setFixtureSessions;
        return yield* body(file, ready);
      }).pipe(Effect.provide(runtime(file, ready)));
    }),
  ).pipe(
    Effect.provide(
      ServerConfig.layerTest("/fixture", { prefix: "throughline-comsnet-committed-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

// Known-bad polarity: same committed stream, deliberately no correlation consumer.
const observe: typeof observeCommittedRuns = (events) =>
  process.env.THROUGHLINE_COMPLETION_BASELINE === "1"
    ? Stream.runDrain(events)
    : observeCommittedRuns(events);

const createRequest = Effect.gen(function* () {
  const transport = yield* Transport.ComsNetTransport;
  const request = yield* transport.send(scope(senderThread), {
    targetPeerId: `codex:mcp-${receiverThread}`,
    kind: "task",
    payload: "Do fixture work",
  });
  yield* transport.markDispatchSucceeded(scope(senderThread), request.requestId);
  return request;
});
const commitTerminal = (runId: string, ids: readonly string[], status: string, answer = true) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      ordinal: number;
    }>`SELECT COALESCE(MAX(ordinal),0)+1 AS ordinal FROM orchestration_v2_projection_runs WHERE thread_id=${receiverThread}`;
    const ordinal = rows[0]!.ordinal;
    const events: OrchestrationV2DomainEvent[] = [
      event("run.created", runPayload(runId, "running", ordinal), `run-create-${runId}`),
      message(runId, "user", ids.map((id) => `<!-- comsnet-request:${id} -->`).join("\n"), null),
    ];
    if (answer)
      events.push(
        message(runId, "assistant", "Child answer must not win", `child-${runId}`, "child"),
        message(runId, "assistant", "Actual main answer", `root-${runId}`),
      );
    events.push(event("run.updated", runPayload(runId, status, ordinal), `terminal-${runId}`));
    yield* sink.write({ events });
  });

it.effect(
  "real committed stream completes the ordinary main answer after SQL commit without roster-read deadlock",
  () =>
    fixture((_file, ready) =>
      Effect.gen(function* () {
        const request = yield* createRequest;
        const sink = yield* EventSink.EventSinkV2;
        const observer = yield* observe(
          sink.stream({ afterSequence: 0, eventType: "run.updated" }).pipe(Stream.take(1)),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(ready);
        yield* commitTerminal("live", [request.requestId], "completed");
        yield* Fiber.join(observer);
        const result = yield* (yield* Transport.ComsNetTransport).status(
          scope(senderThread),
          request.requestId,
        );
        assert.equal(result.status, "completed");
        assert.deepEqual(result.result, {
          text: "Actual main answer",
          assistantMessageId: "assistant-live",
          turnId: "live",
        });
        assert.deepEqual(
          yield* (yield* SqlClient.SqlClient)`SELECT status FROM orchestration_v2_projection_runs WHERE run_id='live'`,
          [{ status: "completed" }],
        );
      }),
    ),
);

it.effect(
  "real committed stream fails an ordinary failed turn and a completed turn without a final message",
  () =>
    fixture(() =>
      Effect.gen(function* () {
        const transport = yield* Transport.ComsNetTransport,
          sink = yield* EventSink.EventSinkV2;
        for (const [runId, status] of [
          ["failed", "failed"],
          ["missing", "completed"],
        ] as const) {
          const request = yield* createRequest;
          yield* commitTerminal(runId, [request.requestId], status, false);
          yield* observe(
            sink.stream({ afterSequence: 0, eventType: "run.updated" }).pipe(
              Stream.filter(
                (row) => row.event.type === "run.updated" && row.event.payload.id === runId,
              ),
              Stream.take(1),
            ),
          );
          assert.equal(
            (yield* transport.status(scope(senderThread), request.requestId)).status,
            "failed",
          );
        }
      }),
    ),
);

it.effect("real committed stream refuses both ambiguous marker candidates", () =>
  fixture(() =>
    Effect.gen(function* () {
      const first = yield* createRequest,
        second = yield* createRequest;
      yield* commitTerminal("ambiguous", [first.requestId, second.requestId], "completed");
      const sink = yield* EventSink.EventSinkV2;
      yield* observe(
        sink.stream({ afterSequence: 0, eventType: "run.updated" }).pipe(Stream.take(1)),
      );
      const transport = yield* Transport.ComsNetTransport;
      for (const request of [first, second])
        assert.equal(
          (yield* transport.status(scope(senderThread), request.requestId)).status,
          "failed",
        );
    }),
  ),
);

it.effect(
  "committed replay re-reads the terminal and converges without another request transition",
  () =>
    fixture(() =>
      Effect.gen(function* () {
        const request = yield* createRequest;
        yield* commitTerminal("replay", [request.requestId], "completed");
        const sink = yield* EventSink.EventSinkV2,
          transport = yield* Transport.ComsNetTransport;
        const replay = () =>
          observe(sink.stream({ afterSequence: 0, eventType: "run.updated" }).pipe(Stream.take(1)));
        yield* replay();
        const first = yield* transport.status(scope(senderThread), request.requestId);
        assert.equal(first.status, "completed");
        yield* replay();
        assert.deepEqual(yield* transport.status(scope(senderThread), request.requestId), first);
      }),
    ),
);

it.effect(
  "closed SQLite/relay scope reopens and finishes a terminal committed before the observer existed",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem,
          path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "throughline-comsnet-reopen-",
        });
        const file = path.join(directory, "state.sqlite");
        const firstReady = yield* Deferred.make<void>();
        const requestId = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* (yield* EventSink.EventSinkV2).write({
              events: [threadEvent(senderThread), threadEvent(receiverThread)],
            });
            yield* setFixtureSessions;
            const request = yield* createRequest;
            yield* commitTerminal("reopened", [request.requestId], "completed");
            return request.requestId;
          }).pipe(Effect.provide(runtime(file, firstReady))),
        );
        const secondReady = yield* Deferred.make<void>();
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* setFixtureSessions;
            const sink = yield* EventSink.EventSinkV2,
              transport = yield* Transport.ComsNetTransport;
            yield* observe(
              sink.stream({ afterSequence: 0, eventType: "run.updated" }).pipe(Stream.take(1)),
            );
            const completed = yield* transport.status(scope(senderThread), requestId);
            assert.equal(completed.status, "completed");
            assert.deepEqual(completed.result, {
              text: "Actual main answer",
              assistantMessageId: "assistant-reopened",
              turnId: "reopened",
            });
          }).pipe(Effect.provide(runtime(file, secondReady))),
        );
      }),
    ).pipe(
      Effect.provide(
        ServerConfig.layerTest("/fixture", { prefix: "throughline-comsnet-reopen-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);
