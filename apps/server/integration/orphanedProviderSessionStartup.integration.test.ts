import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { CodexProviderCapabilitiesV2 } from "../src/orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../src/orchestration-v2/EventSink.ts";
import * as EventStore from "../src/orchestration-v2/EventStore.ts";
import * as EffectOutbox from "../src/orchestration-v2/EffectOutbox.ts";
import * as ProjectionStore from "../src/orchestration-v2/ProjectionStore.ts";
import * as Recovery from "../src/orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as Sqlite from "../src/persistence/Sqlite.ts";
import * as ServerRuntimeStartup from "../src/serverRuntimeStartup.ts";
import * as ServerSettings from "../src/serverSettings.ts";

// V1 source preserved byte-for-byte in V1-Test-Evidence. V2 represents an orphan
// with cancelled runs/stopped sessions, not V1 error bindings. Native references
// and newer-turn continuation survive through the real SQL/event/outbox seams.
const threadId = ThreadId.make("startup-orphan");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const sessionId = ProviderSessionId.make("startup-session");
const providerThreadId = ProviderThreadId.make("startup-provider-thread");
const modelSelection = { instanceId, model: "gpt-5.4" };
const now = DateTime.makeUnsafe("2026-10-11T08:00:00Z");
const nativeThreadRef = {
  driver,
  nativeId: "native-session-before-restart",
  strength: "strong" as const,
};

function seedEvents(
  status: OrchestrationV2Run["status"],
  sessionStatus: OrchestrationV2ProviderSession["status"],
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const runId = RunId.make("newer-run");
  const nodeId = NodeId.make("newer-root");
  const attemptId = RunAttemptId.make("newer-attempt");
  const run: OrchestrationV2Run = {
    id: runId,
    threadId,
    ordinal: 2,
    providerInstanceId: instanceId,
    modelSelection,
    providerThreadId,
    userMessageId: MessageId.make("newer-prompt"),
    rootNodeId: nodeId,
    activeAttemptId: attemptId,
    status,
    requestedAt: now,
    startedAt: status === "running" ? now : null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  return [
    {
      id: EventId.make("thread"),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        id: threadId,
        projectId: ProjectId.make("startup-project"),
        title: "Startup orphan",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThreadId,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    },
    {
      id: EventId.make("session"),
      type: "provider-session.attached",
      threadId,
      occurredAt: now,
      payload: {
        id: sessionId,
        driver,
        providerInstanceId: instanceId,
        status: sessionStatus,
        cwd: "/fixture/startup",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    },
    {
      id: EventId.make("provider-thread"),
      type: "provider-thread.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: providerThreadId,
        driver,
        providerInstanceId: instanceId,
        providerSessionId: sessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef,
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: 1,
        lastRunOrdinal: 2,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    },
    {
      id: EventId.make("old-run"),
      type: "run.created",
      threadId,
      occurredAt: now,
      payload: {
        ...run,
        id: RunId.make("original-run"),
        ordinal: 1,
        activeAttemptId: null,
        rootNodeId: null,
        userMessageId: MessageId.make("original-prompt"),
        status: "completed",
        completedAt: now,
        requestedAt: DateTime.subtract(now, { minutes: 1 }),
        startedAt: DateTime.subtract(now, { minutes: 1 }),
      },
    },
    { id: EventId.make("new-run"), type: "run.created", threadId, occurredAt: now, payload: run },
    {
      id: EventId.make("attempt"),
      type: "run-attempt.created",
      threadId,
      runId,
      occurredAt: now,
      payload: {
        id: attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId: nodeId,
        providerInstanceId: instanceId,
        providerThreadId,
        providerTurnId: ProviderTurnId.make("newer-native-turn"),
        reason: "initial",
        status: status === "running" ? "running" : "pending",
        startedAt: now,
        completedAt: null,
      },
    },
    {
      id: EventId.make("turn"),
      type: "provider-turn.updated",
      threadId,
      runId,
      nodeId,
      occurredAt: now,
      payload: {
        id: ProviderTurnId.make("newer-native-turn"),
        providerThreadId,
        nodeId,
        runAttemptId: attemptId,
        nativeTurnRef: { driver, nativeId: "actual-newer-turn", strength: "strong" },
        ordinal: 2,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    },
  ];
}

function persistence(path: string) {
  const db = Sqlite.layerFromPath(path);
  const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer, EffectOutbox.layer).pipe(
    Layer.provideMerge(db),
  );
  return EventSink.layer.pipe(Layer.provideMerge(stores));
}

function recoveryLayer(path: string, continueAfterRestart = false) {
  return Recovery.layer.pipe(
    Layer.provideMerge(persistence(path)),
    Layer.provide(IdAllocator.layer),
    Layer.provide(
      ServerSettings.layerTest({ continueThreadsAfterServerUpdate: continueAfterRestart }),
    ),
  );
}

function withRestart(
  status: OrchestrationV2Run["status"],
  sessionStatus: OrchestrationV2ProviderSession["status"],
  continueAfterRestart = false,
  prepare = false,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "throughline-v2-orphan-" });
    const db = path.join(dir, "state.sqlite");
    yield* Effect.gen(function* () {
      yield* (yield* EventSink.EventSinkV2).write({ events: seedEvents(status, sessionStatus) });
      if (prepare) yield* (yield* Recovery.ProviderRuntimeRecoveryService).prepareForShutdown;
    }).pipe(Effect.provide(recoveryLayer(db, continueAfterRestart)), Effect.scoped);
    // A new layer reopens the actual SQLite file; no state is carried in mocks.
    return db;
  });
}

it.effect.each(["starting", "stopped"] as const)(
  "recovers a persisted starting run with a %s binding before opening the command gate after restart",
  (sessionStatus) =>
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* withRestart("starting", sessionStatus);
        yield* Effect.gen(function* () {
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const recovery = yield* Recovery.ProviderRuntimeRecoveryService;
          const gate = yield* ServerRuntimeStartup.makeCommandGate;
          const queuedStarted = yield* Deferred.make<void>();
          const queued = yield* gate
            .enqueueCommand(Deferred.succeed(queuedStarted, undefined))
            .pipe(Effect.forkScoped);
          assert.isFalse(yield* Deferred.isDone(queuedStarted));
          yield* ServerRuntimeStartup.runOrderedV2StartupPhases({
            importLegacyShells: Effect.void,
            recover: recovery.recover,
            recoverDelegatedTasks: Effect.void,
            startEffectWorker: Effect.void,
            autoBootstrap: Effect.void,
          });
          const snapshot = yield* projections.getThreadProjection(threadId);
          assert.equal(snapshot.runs.find((run) => run.id === "newer-run")?.status, "cancelled");
          assert.equal(snapshot.providerSessions[0]?.status, "stopped");
          assert.equal(snapshot.providerThreads[0]?.status, "idle");
          assert.deepEqual(snapshot.providerThreads[0]?.nativeThreadRef, nativeThreadRef);
          assert.equal(snapshot.providerThreads[0]?.lastRunOrdinal, 2);
          assert.isFalse(yield* Deferred.isDone(queuedStarted));
          yield* gate.signalCommandReady;
          yield* Fiber.join(queued);
          assert.isTrue(yield* Deferred.isDone(queuedStarted));
          assert.equal((yield* recovery.recover).terminalizedRuns, 0);
        }).pipe(Effect.provide(recoveryLayer(db)));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["opt-in desktop restart", "marked remote update"] as const)(
  "continues a newer persisted turn after %s",
  (restart) =>
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* withRestart(
          "running",
          "running",
          true,
          restart === "marked remote update",
        );
        yield* Effect.gen(function* () {
          const recovery = yield* Recovery.ProviderRuntimeRecoveryService;
          const outbox = yield* EffectOutbox.EffectOutboxV2;
          yield* recovery.recover;
          yield* recovery.recover;
          const continuation = yield* outbox.get("effect:restart-continuation:newer-run");
          assert.equal(continuation._tag, "Some");
          if (continuation._tag === "Some") {
            assert.equal(continuation.value.status, "pending");
            assert.deepEqual(continuation.value.request, {
              type: "provider-runtime.continue",
              sourceRunId: RunId.make("newer-run"),
            });
          }
          assert.equal(
            (yield* outbox.get("effect:restart-continuation:original-run"))._tag,
            "None",
          );
        }).pipe(Effect.provide(recoveryLayer(db, true)));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("does not create restart continuation from a stopped native session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const db = yield* withRestart("running", "stopped", true);
      yield* Effect.gen(function* () {
        yield* (yield* Recovery.ProviderRuntimeRecoveryService).recover;
        assert.equal(
          (yield* (yield* EffectOutbox.EffectOutboxV2).get("effect:restart-continuation:newer-run"))
            ._tag,
          "None",
        );
      }).pipe(Effect.provide(recoveryLayer(db, true)));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
