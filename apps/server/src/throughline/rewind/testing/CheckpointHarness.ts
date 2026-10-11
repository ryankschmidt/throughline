import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert } from "@effect/vitest";
import {
  CommandId,
  ThreadId,
  RunId,
  CheckpointScopeId,
  OrchestrationV2StoredEventJson,
  MessageId,
  ProviderInstanceId,
  ProjectId,
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  ClaudeSettings,
  AuthSessionId,
  AuthOrchestrationOperateScope,
  OrchestrationV2StoredEvent,
  type OrchestrationV2Checkpoint,
  EventId,
  NodeId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Option from "effect/Option";
import { HttpRouter } from "effect/http";
import * as EventSink from "../../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../../orchestration-v2/EventStore.ts";
import * as EffectOutbox from "../../../orchestration-v2/EffectOutbox.ts";
import * as Ingestor from "../../../orchestration-v2/ProviderEventIngestor.ts";
import * as ProviderReplayHarness from "../../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ProviderRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../../../orchestration-v2/ThreadMessageIntake.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as CheckpointStore from "../../../checkpointing/CheckpointStore.ts";
import * as CheckpointService from "../../../orchestration-v2/CheckpointService.ts";
import * as Capture from "../../../orchestration-v2/CheckpointCaptureService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import * as VcsRegistry from "../../../vcs/VcsDriverRegistry.ts";
import * as ServerConfig from "../../../config.ts";
import * as ProjectionObservation from "../../observation/ProjectionObservation.ts";
import { faultCaptureReadOnce } from "./FaultingProjectionStore.ts";
import { makeClaudeAdapterV2 } from "../../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import {
  ProviderSessionManagerV2,
  ProviderSessionOpenError,
} from "../../../orchestration-v2/ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "../../../orchestration-v2/RuntimePolicy.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import { makeLayer as rewindLayer } from "../ExactMessageRewindRuntime.ts";
import { rewindRouteLayer } from "../http.ts";
import { EnvironmentAuth } from "../../../auth/EnvironmentAuth.ts";

export const threadId = ThreadId.make("checkpoint-contention"),
  runId = RunId.make("contention-run"),
  scopeId = CheckpointScopeId.make("contention-scope");
const at = "2026-10-11T00:00:00.000Z";
const nativeSessionId = "00000000-0000-4000-8000-000000000001";

export const assertQueuedCaptureAfterCut = (queued: boolean) =>
  fixture((state) =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      if (queued)
        yield* outbox.enqueue([
          {
            id: "queued-capture",
            commandId: CommandId.make("queued-capture-command"),
            threadId,
            request: { type: "checkpoint.capture", runId, scopeId },
          },
        ]);
      const { handler, dispose } = yield* makeControlledRewindHandler(state);
      yield* Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          handler(
            new Request(`http://fixture/throughline/threads/${threadId}/rewind`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: encodeRewindRequest({ messageId: MessageId.make("user") }),
            }),
          ),
        );
        assert.equal(response.status, 200);
        if (queued) {
          const claim = yield* outbox.claimNext({ workerId: "fixture", leaseDurationMs: 10000 });
          assert.isTrue(Option.isSome(claim));
          if (Option.isSome(claim)) assert.equal(claim.value.request.type, "checkpoint.capture");
        }
        yield* (yield* Capture.CheckpointCaptureServiceV2).execute({ threadId, runId, scopeId });
        const records = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadRecords(
          threadId,
          ["runs", "checkpoints", "providerThreads"],
        );
        assert.equal(records.runs[0]?.status, "rolled_back");
        assert.isNull(records.providerThreads[0]?.lastRunOrdinal);
        assert.equal(records.checkpoints.filter((row) => row.runId === runId).length, 0);
      }).pipe(Effect.ensuring(Effect.promise(dispose)));
    }),
  );

export const assertLostProviderOwnershipAfterCut = (guard: "run" | "provider") =>
  fixture((state) =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      yield* sink.write({
        events: [
          event("run.updated", { ...run("waiting"), activeAttemptId: "attempt" }),
          event("run-attempt.updated", {
            id: "attempt",
            runId,
            attemptOrdinal: 1,
            rootNodeId: "root",
            providerInstanceId: "claude",
            providerThreadId: "provider",
            providerTurnId: null,
            reason: "initial",
            status: "completed",
            startedAt: at,
            completedAt: at,
          }),
        ],
      });
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const before = yield* projections.getThreadRecords(threadId, ["providerThreads"]);
      const ingestor = yield* Ingestor.ProviderEventIngestorV2;
      const input: Ingestor.ProviderEventIngestInput = {
        providerSessionId: ProviderSessionId.make("session"),
        providerInstanceId: ProviderInstanceId.make("claude"),
        threadId,
        runId,
        event: {
          type: "provider_thread.updated",
          driver: ProviderDriverKind.make("claudeAgent"),
          providerThread: before.providerThreads[0]!,
        },
      };
      const ownership =
        guard === "run"
          ? {
              writeIfRunCurrent: {
                runId,
                activeAttemptId: RunAttemptId.make("attempt"),
                expectedStatus: "waiting" as const,
              },
            }
          : {
              writeIfProviderThreadOwner: {
                providerThreadId: ProviderThreadId.make("provider"),
                runId,
                activeAttemptId: RunAttemptId.make("attempt"),
                expectedLastRunOrdinal: 1,
              },
            };
      const good = yield* ingestor.ingestNormalized({ ...input, ...ownership });
      assert.equal(good.length, 1, "the same live-owner input must commit before the cut");
      const { handler, dispose } = yield* makeControlledRewindHandler(state);
      yield* Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          handler(
            new Request(`http://fixture/throughline/threads/${threadId}/rewind`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: encodeRewindRequest({ messageId: MessageId.make("user") }),
            }),
          ),
        );
        assert.equal(response.status, 200);
        const lost = yield* ingestor.ingestNormalized({ ...input, ...ownership });
        assert.equal(
          lost.length,
          0,
          "late provider snapshot must not publish after ownership is lost",
        );
        const after = yield* projections.getThreadRecords(threadId, [
          "runs",
          "providerThreads",
          "checkpoints",
        ]);
        assert.equal(after.runs[0]?.status, "rolled_back");
        assert.isNull(after.providerThreads[0]?.lastRunOrdinal);
        assert.equal(after.checkpoints.filter((row) => row.runId === runId).length, 0);
        yield* (yield* Capture.CheckpointCaptureServiceV2).execute({ threadId, runId, scopeId });
      }).pipe(Effect.ensuring(Effect.promise(dispose)));
    }),
  );
const encodeRewindRequest = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ messageId: MessageId })),
);
let nextEvent = 0;
function event(type: string, payload: unknown) {
  return Schema.decodeUnknownSync(OrchestrationV2StoredEventJson)({
    sequence: 1,
    commandId: null,
    event: { id: `contention-event-${nextEvent++}`, type, threadId, occurredAt: at, payload },
  }).event;
}
const run = (status: string) => ({
  id: runId,
  threadId,
  ordinal: 1,
  providerInstanceId: "claude",
  modelSelection: { instanceId: "claude", model: "test" },
  providerThreadId: "provider",
  userMessageId: "user",
  rootNodeId: "root",
  activeAttemptId: null,
  status,
  requestedAt: at,
  startedAt: at,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
});

export interface FixtureState {
  readonly publications: () => ReadonlyArray<OrchestrationV2StoredEvent>;
  readonly cwd: string;
  readonly transcript: string;
  readonly pauseCapture: (
    entered: Deferred.Deferred<void>,
    release: Deferred.Deferred<void>,
  ) => void;
}
export function fixture<A, E, R>(
  body: Effect.Effect<A, E, R> | ((state: FixtureState) => Effect.Effect<A, E, R>),
) {
  let gate: { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> } | undefined;
  const publications: Array<OrchestrationV2StoredEvent> = [];
  const sql = Sqlite.layerMemory;
  const projections = (
    globalThis.process.env.THROUGHLINE_CAPTURE_GUARD_BASELINE === "1"
      ? Layer.effect(
          ProjectionStore.ProjectionStoreV2,
          Effect.map(ProjectionStore.ProjectionStoreV2, (base) => ({
            ...base,
            // Known-bad baseline: retain transaction-scoped observation stamping,
            // omit only CaptureAfterCutRefusal, so the cut itself still executes.
            apply: (event) =>
              base.apply(event).pipe(
                Effect.andThen(
                  Effect.gen(function* () {
                    const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
                    if (Option.isNone(sql))
                      return yield* new ProjectionStore.ProjectionStoreApplyEventError({
                        eventType: event.type,
                        cause: "Transaction SqlClient unavailable",
                      });
                    yield* ProjectionObservation.observeEvents([{ event }]).pipe(
                      Effect.provideService(SqlClient.SqlClient, sql.value),
                    );
                  }),
                ),
                Effect.mapError(
                  (cause) =>
                    new ProjectionStore.ProjectionStoreApplyEventError({
                      eventType: event.type,
                      cause,
                    }),
                ),
              ),
          })),
        )
      : ProjectionObservation.layer
  ).pipe(Layer.provide(ProjectionStore.layer));
  const stores = Layer.mergeAll(projections, EventStore.layer, EffectOutbox.layer).pipe(
    Layer.provideMerge(sql),
  );
  const publishWitness = Layer.effect(
    EventStore.EventStoreV2,
    Effect.map(EventStore.EventStoreV2, (base) => ({
      ...base,
      publishCommitted: (events) =>
        Effect.gen(function* () {
          for (const row of events) if ("event" in row) publications.push(row);
          yield* base.publishCommitted(events);
        }),
    })),
  ).pipe(Layer.provide(stores));
  const sink = EventSink.layer.pipe(Layer.provide(publishWitness), Layer.provideMerge(stores));
  const process = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
  const pinnedProcess = Layer.effect(
    VcsProcess.VcsProcess,
    Effect.map(VcsProcess.VcsProcess, (base) => ({
      run: (input: VcsProcess.VcsProcessInput) =>
        base.run({
          ...input,
          command: input.command === "git" ? "/opt/homebrew/bin/git" : input.command,
        }),
    })),
  ).pipe(Layer.provide(process));
  const vcs = VcsRegistry.layer.pipe(Layer.provide(pinnedProcess));
  // Delays the real filesystem/VCS boundary, not a mocked capture result.
  const delayedStore = Layer.effect(
    CheckpointStore.CheckpointStore,
    Effect.map(CheckpointStore.CheckpointStore, (base) => ({
      ...base,
      captureCheckpoint: (input) =>
        Effect.gen(function* () {
          if (gate !== undefined) {
            yield* Deferred.succeed(gate.entered, undefined);
            yield* Deferred.await(gate.release);
          }
          return yield* base.captureCheckpoint(input);
        }),
    })),
  ).pipe(Layer.provide(CheckpointStore.layer.pipe(Layer.provide(vcs))));
  const checkpoint = CheckpointService.layer.pipe(Layer.provide(delayedStore));
  const external = Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    IdAllocator.layer,
    McpProviderSessions.layer,
    ThreadCommandExecutor.layer,
    pinnedProcess,
    ServerConfig.ServerConfig.layerTest(processCwd(), {
      prefix: "throughline-contention-v2-",
    }).pipe(Layer.provide(NodeServices.layer)),
  );
  const layers = Layer.mergeAll(
    Ingestor.layer.pipe(Layer.provide(sink)),
    sink,
    Capture.layer.pipe(Layer.provideMerge(checkpoint), Layer.provide(sink)),
  );
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem,
        path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "throughline-contention-git-" });
      const git = yield* VcsProcess.VcsProcess;
      for (const args of [
        ["init"],
        ["config", "user.name", "Fixture"],
        ["config", "user.email", "fixture@example.test"],
      ])
        yield* git.run({
          operation: "contention.fixture.git",
          command: "/opt/homebrew/bin/git",
          cwd,
          args,
        });
      yield* fs.writeFileString(path.join(cwd, "README.md"), "retained bytes\n");
      yield* git.run({
        operation: "contention.fixture.git",
        command: "/opt/homebrew/bin/git",
        cwd,
        args: ["add", "README.md"],
      });
      yield* git.run({
        operation: "contention.fixture.git",
        command: "/opt/homebrew/bin/git",
        cwd,
        args: ["commit", "-m", "fixture"],
      });
      const folder = path.join(cwd, "native", "projects", "fixture");
      yield* fs.makeDirectory(folder, { recursive: true });
      const transcript = path.join(folder, `${nativeSessionId}.jsonl`);
      yield* fs.writeFileString(
        transcript,
        '{"uuid":"hook","parentUuid":null}\n{"uuid":"selected-native","parentUuid":"hook"}\n{"uuid":"later","parentUuid":"selected-native"}\n',
      );
      const sink = yield* EventSink.EventSinkV2;
      yield* sink.write({
        commandId: CommandId.make("contention-seed"),
        events: [
          event("thread.created", {
            id: threadId,
            projectId: "project",
            title: "Contention",
            providerInstanceId: "claude",
            modelSelection: { instanceId: "claude", model: "test" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            activeProviderThreadId: "provider",
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
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
          }),
          event("run.created", run("waiting")),
          event("node.updated", {
            id: "root",
            threadId,
            runId,
            parentNodeId: null,
            rootNodeId: "root",
            kind: "root_turn",
            status: "waiting",
            countsForRun: true,
            providerThreadId: "provider",
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: scopeId,
            startedAt: at,
            completedAt: null,
          }),
          event("provider-thread.updated", {
            id: "provider",
            driver: "claudeAgent",
            providerInstanceId: "claude",
            providerSessionId: "session",
            appThreadId: threadId,
            ownerNodeId: "root",
            nativeThreadRef: {
              driver: "claudeAgent",
              nativeId: nativeSessionId,
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: at,
            updatedAt: at,
          }),
          event("checkpoint-scope.created", {
            id: scopeId,
            threadId,
            runId,
            nodeId: "root",
            parentScopeId: null,
            providerThreadId: "provider",
            kind: "root_run",
            ordinalWithinParent: 0,
            advancesAppRunCount: true,
            cwd,
            createdAt: at,
          }),
          event("message.updated", {
            id: "user",
            threadId,
            runId,
            nodeId: "root",
            role: "user",
            text: "selected prompt",
            attachments: [],
            streaming: false,
            createdBy: "user",
            creationSource: "web",
            createdAt: at,
            updatedAt: at,
          }),
          event("turn-item.updated", {
            id: "user-item",
            threadId,
            runId,
            nodeId: "root",
            providerThreadId: "provider",
            providerTurnId: null,
            parentItemId: null,
            ordinal: 1,
            type: "user_message",
            status: "completed",
            messageId: "user",
            title: null,
            startedAt: at,
            completedAt: at,
            updatedAt: at,
            inputIntent: "turn_start",
            text: "selected prompt",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            nativeItemRef: {
              driver: "claudeAgent",
              nativeId: "selected-native",
              strength: "strong",
            },
          }),
        ],
      });
      return yield* typeof body === "function"
        ? body({
            cwd,
            transcript,
            publications: () => publications,
            pauseCapture: (entered, release) => {
              gate = { entered, release };
            },
          })
        : body;
    }).pipe(Effect.provide(layers.pipe(Layer.provideMerge(external)))),
  );
}
function processCwd() {
  return globalThis.process.cwd();
}

export const makeControlledRewindHandler = (
  state: FixtureState,
  options: {
    readonly activeAdapterTurn?: boolean;
    readonly onRollbackRefusal?: (cause: unknown) => void;
    readonly onSessionOpenRefusal?: (cause: unknown) => void;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const adapter = yield* makeClaudeAdapterV2({
      instanceId: ProviderInstanceId.make("claude"),
      settings: yield* Schema.decodeEffect(ClaudeSettings)({}),
      environment: {},
      attachmentsDir: state.cwd,
      fileSystem: fs,
      path,
      crypto: yield* Crypto.Crypto,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      queryRunner: {
        allocateSessionId: Effect.die("rewind must not allocate"),
        open: () =>
          options.activeAdapterTurn
            ? Effect.succeed({
                messages: Stream.never,
                offer: () => Effect.void,
                setModel: () => Effect.void,
                setPermissionMode: () => Effect.void,
                interrupt: Effect.void,
                close: Effect.void,
              })
            : Effect.die("cut must not query a live provider"),
        forkSession: () => Effect.die("rewind must not fork"),
        subagentLaunchToolUseId: () => Effect.succeed(null),
        assertComplete: Effect.void,
      },
    });
    const policy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: state.cwd,
    });
    const parentScope = yield* Effect.scope;
    // Controlled SDK/session gateway only; the adapter, SQL stores, sink,
    // capture service and Git operations are real and no store is mocked.
    const runtime = rewindLayer({ resolveTranscriptPath: async () => state.transcript }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(RuntimePolicyV2, { resolve: () => Effect.succeed(policy) }),
          Layer.mock(ProviderSessionManagerV2)({
            open: (input) =>
              adapter.openSession({ ...input, runtimePolicy: policy }).pipe(
                Effect.tap((session) =>
                  options.activeAdapterTurn
                    ? Effect.gen(function* () {
                        const records = yield* projections.getThreadRecords(threadId, [
                          "providerThreads",
                          "runs",
                        ]);
                        const providerThread = records.providerThreads[0]!,
                          currentRun = records.runs.find((row) => row.id === runId)!;
                        if (currentRun.rootNodeId === null)
                          return yield* Effect.die("active adapter fixture requires a root node");
                        // Real adapter state races the idle projection. Only its SDK
                        // backend is controlled; rollback itself is not mocked.
                        yield* session.startTurn({
                          appThread: records.thread,
                          threadId,
                          runId,
                          runOrdinal: currentRun.ordinal,
                          providerTurnOrdinal: 1,
                          nativeThreadHasTurns: true,
                          attemptId: RunAttemptId.make("rollback-refusal-attempt"),
                          rootNodeId: currentRun.rootNodeId,
                          providerThread,
                          message: {
                            messageId: MessageId.make("adapter-only-active-message"),
                            text: "controlled active adapter turn",
                            attachments: [],
                            createdBy: "user",
                            creationSource: "web",
                          },
                          modelSelection: records.thread.modelSelection,
                          runtimePolicy: policy,
                        });
                      })
                    : Effect.void,
                ),
                Effect.map((session) =>
                  options.onRollbackRefusal === undefined
                    ? session
                    : {
                        ...session,
                        rollbackThread: (input: Parameters<typeof session.rollbackThread>[0]) =>
                          session
                            .rollbackThread(input)
                            .pipe(
                              Effect.tapError((cause) =>
                                Effect.sync(() => options.onRollbackRefusal?.(cause)),
                              ),
                            ),
                      },
                ),
                Effect.catchCause((cause) =>
                  Effect.sync(() => options.onSessionOpenRefusal?.(cause)).pipe(
                    Effect.andThen(Effect.failCause(cause)),
                  ),
                ),
                Effect.provideService(Scope.Scope, parentScope),
                Effect.mapError(
                  (cause) =>
                    new ProviderSessionOpenError({
                      instanceId: input.modelSelection.instanceId,
                      providerSessionId: input.providerSessionId,
                      cause,
                    }),
                ),
              ),
          }),
        ),
      ),
    );
    const context = yield* Effect.context<
      | EventSink.EventSinkV2
      | EventStore.EventStoreV2
      | ProjectionStore.ProjectionStoreV2
      | IdAllocator.IdAllocatorV2
      | ThreadCommandExecutor.ThreadCommandExecutor
      | SqlClient.SqlClient
      | FileSystem.FileSystem
      | Path.Path
    >();
    const routes = rewindRouteLayer.pipe(
      Layer.provideMerge(runtime),
      Layer.provideMerge(Layer.succeedContext(context)),
      Layer.provideMerge(
        Layer.mock(EnvironmentAuth)({
          authenticateHttpRequest: () =>
            Effect.succeed({
              sessionId: AuthSessionId.make("fixture"),
              subject: "fixture",
              method: "bearer-access-token",
              scopes: [AuthOrchestrationOperateScope],
            }),
        }),
      ),
    );
    return HttpRouter.toWebHandler(routes, { disableLogger: true });
  });

export const assertDelayedCaptureAfterCut = () =>
  fixture((state) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { handler, dispose } = yield* makeControlledRewindHandler(state);
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>();
      state.pauseCapture(entered, release);
      const capture = yield* Capture.CheckpointCaptureServiceV2;
      const pending = yield* capture
        .execute({ threadId, runId, scopeId })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Effect.gen(function* () {
        yield* Deferred.await(entered);
        const response = yield* Effect.promise(() =>
          handler(
            new Request(`http://fixture/throughline/threads/${threadId}/rewind`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: encodeRewindRequest({ messageId: MessageId.make("user") }),
            }),
          ),
        );
        assert.equal(response.status, 200, "idle-awaiting-capture must not delay the exact cut");
        yield* Deferred.succeed(release, undefined);
        const outcome = yield* Fiber.join(pending);
        assert.isTrue(Exit.isFailure(outcome), "stale capture transaction must refuse");
        if (Exit.isFailure(outcome)) {
          let current: unknown = Cause.squash(outcome.cause);
          const causes: Array<unknown> = [];
          for (let depth = 0; current !== undefined && depth < 16; depth++) {
            if (Cause.isCause(current)) current = Cause.squash(current);
            causes.push(current);
            current =
              typeof current === "object" && current !== null && "cause" in current
                ? current.cause
                : undefined;
          }
          assert.isTrue(
            causes.some(Schema.is(ProjectionObservation.CaptureAfterCutRefusal)),
            "exact typed CaptureAfterCutRefusal must cause the transaction failure",
          );
        }
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const after = yield* projections.getThreadRecords(threadId, [
          "runs",
          "checkpoints",
          "messages",
        ]);
        assert.equal(after.runs[0]?.status, "rolled_back");
        assert.isNull(after.runs[0]?.checkpointId);
        assert.equal(after.checkpoints.filter((c) => c.runId === runId).length, 0);
        const written = yield* (yield* EventStore.EventStoreV2)
          .readByCommandId({
            commandId: CommandId.make(`command:effect:checkpoint.capture:${runId}`),
          })
          .pipe(Stream.runCollect);
        assert.equal(
          written.length,
          0,
          "the entire refused capture command must have zero stored events",
        );
        assert.equal(
          state
            .publications()
            .filter(
              (row) =>
                row.event.type === "checkpoint.captured" && row.event.payload.runId === runId,
            ).length,
          0,
          "no capture can publish after the cut",
        );
        assert.include(yield* fs.readFileString(state.transcript), '"uuid":"later"');
        yield* capture.execute({ threadId, runId, scopeId }); // retry hits silent rolled_back guard
        assert.equal(
          (yield* projections.getThreadRecords(threadId, ["checkpoints"])).checkpoints.filter(
            (c) => c.runId === runId,
          ).length,
          0,
        );
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined)),
        Effect.ensuring(Effect.promise(dispose)),
      );
    }),
  );

export const assertStillValidBlockedCapture = (
  variant: "retained-message-less" | "failed-provider-rollback" | "older-retained-completion",
) =>
  fixture((state) =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2,
        projections = yield* ProjectionStore.ProjectionStoreV2;
      const beforeSeed = yield* projections.getThreadRecords(threadId, [
        "runs",
        "nodes",
        "messages",
        "turnItems",
        "checkpointScopes",
        "providerThreads",
      ]);
      const current = beforeSeed.runs[0]!,
        root = beforeSeed.nodes[0]!,
        message = beforeSeed.messages[0]!,
        item = beforeSeed.turnItems[0]!,
        scope = beforeSeed.checkpointScopes[0]!,
        provider = beforeSeed.providerThreads[0]!;
      // These are already-decoded projection rows, so validate against the
      // decoded event contract rather than its wire-DateTime string contract.
      const event = (type: string, payload: unknown) =>
        Schema.decodeUnknownSync(OrchestrationV2StoredEvent)({
          sequence: 1,
          commandId: null,
          event: {
            id: `contention-projected-${nextEvent++}`,
            type,
            threadId,
            occurredAt: current.requestedAt,
            payload,
          },
        }).event;
      let keptLaterCheckpoint: OrchestrationV2Checkpoint | undefined;
      if (variant !== "failed-provider-rollback") {
        const boundaryOrdinal = variant === "older-retained-completion" ? 3 : 2;
        const boundaryRunId = RunId.make("valid-boundary-run"),
          boundaryNodeId = NodeId.make("valid-boundary-root");
        const seedEvents = [
          event("run.updated", {
            ...current,
            userMessageId: MessageId.make("message-less-not-stored"),
          }),
          event("run.created", {
            ...current,
            id: boundaryRunId,
            ordinal: boundaryOrdinal,
            rootNodeId: boundaryNodeId,
            status: "completed",
            completedAt: current.requestedAt,
          }),
          event("node.updated", {
            ...root,
            id: boundaryNodeId,
            rootNodeId: boundaryNodeId,
            runId: boundaryRunId,
            checkpointScopeId: null,
            status: "completed",
            completedAt: current.requestedAt,
          }),
          event("message.updated", { ...message, runId: boundaryRunId, nodeId: boundaryNodeId }),
          event("turn-item.updated", { ...item, runId: boundaryRunId, nodeId: boundaryNodeId }),
          event("provider-thread.updated", { ...provider, lastRunOrdinal: boundaryOrdinal }),
        ];
        if (variant === "older-retained-completion") {
          const laterRunId = RunId.make("valid-newer-retained-run"),
            laterNodeId = NodeId.make("valid-newer-retained-root"),
            laterScopeId = CheckpointScopeId.make("valid-newer-retained-scope");
          const laterScope = { ...scope, id: laterScopeId, runId: laterRunId, nodeId: laterNodeId };
          seedEvents.push(
            event("run.created", {
              ...current,
              id: laterRunId,
              ordinal: 2,
              rootNodeId: laterNodeId,
              userMessageId: MessageId.make("newer-message-not-stored"),
              status: "completed",
              completedAt: current.requestedAt,
            }),
            event("node.updated", {
              ...root,
              id: laterNodeId,
              rootNodeId: laterNodeId,
              runId: laterRunId,
              checkpointScopeId: laterScopeId,
              status: "completed",
              completedAt: current.requestedAt,
            }),
            event("checkpoint-scope.created", laterScope),
          );
          yield* sink.write({ events: seedEvents });
          const later = yield* (yield* CheckpointService.CheckpointServiceV2).capture({
            scope: laterScope,
            runId: laterRunId,
            nodeId: laterNodeId,
            ordinalWithinScope: 1,
            appRunOrdinal: 2,
            capturedAt: yield* DateTime.now,
          });
          yield* sink.write({ events: [event("checkpoint.captured", later)] });
          keptLaterCheckpoint = later;
        } else yield* sink.write({ events: seedEvents });
      }
      const before = yield* projections.getThreadRecords(threadId, [
        "runs",
        "messages",
        "providerThreads",
        "checkpoints",
      ]);
      const fs = yield* FileSystem.FileSystem,
        path = yield* Path.Path;
      const workspaceBefore = yield* fs.readFileString(path.join(state.cwd, "README.md"));
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>();
      state.pauseCapture(entered, release);
      const capture = yield* Capture.CheckpointCaptureServiceV2;
      const pending = yield* capture
        .execute({ threadId, runId, scopeId })
        .pipe(Effect.exit, Effect.forkScoped);
      let adapterRefusal: unknown, openRefusal: unknown;
      const { handler, dispose } = yield* makeControlledRewindHandler(state, {
        activeAdapterTurn: variant === "failed-provider-rollback",
        onRollbackRefusal: (cause) => {
          adapterRefusal = cause;
        },
        onSessionOpenRefusal: (cause) => {
          openRefusal = cause;
        },
      });
      yield* Effect.gen(function* () {
        yield* Deferred.await(entered);
        const response = yield* Effect.promise(() =>
          handler(
            new Request(`http://fixture/throughline/threads/${threadId}/rewind`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: encodeRewindRequest({ messageId: MessageId.make("user") }),
            }),
          ),
        );
        assert.equal(
          response.status,
          variant === "failed-provider-rollback" ? 409 : 200,
          "route witnesses its outcome while capture is held",
        );
        const interim = yield* projections.getThreadRecords(threadId, [
          "runs",
          "messages",
          "checkpoints",
          "providerThreads",
        ]);
        assert.equal(
          interim.runs.find((row) => row.id === runId)?.status,
          "waiting",
          "retained or failed-rollback run remains eligible",
        );
        if (variant === "failed-provider-rollback") {
          const answer: unknown = yield* Effect.promise(() => response.json());
          if (openRefusal !== undefined) {
            const chain: Array<{ tag?: string; message?: string; detail?: string }> = [];
            let cause: unknown = openRefusal;
            for (let i = 0; i < 8 && cause !== undefined; i++) {
              if (Cause.isCause(cause)) cause = Cause.squash(cause);
              if (typeof cause !== "object" || cause === null) break;
              chain.push({
                ...("_tag" in cause && typeof cause._tag === "string" ? { tag: cause._tag } : {}),
                ...("message" in cause && typeof cause.message === "string"
                  ? { message: cause.message }
                  : {}),
                ...("detail" in cause && typeof cause.detail === "string"
                  ? { detail: cause.detail }
                  : {}),
              });
              cause = "cause" in cause ? cause.cause : undefined;
            }
            const encodeChain = Schema.encodeEffect(
              Schema.fromJsonString(
                Schema.Array(
                  Schema.Struct({
                    tag: Schema.optional(Schema.String),
                    message: Schema.optional(Schema.String),
                    detail: Schema.optional(Schema.String),
                  }),
                ),
              ),
            );
            assert.fail(`fixture failed before rollback: ${yield* encodeChain(chain)}`);
          }
          const rollbackCauses: Array<unknown> = [];
          let rollbackCause: unknown = adapterRefusal;
          for (let i = 0; i < 8 && rollbackCause !== undefined; i++) {
            if (Cause.isCause(rollbackCause)) rollbackCause = Cause.squash(rollbackCause);
            rollbackCauses.push(rollbackCause);
            rollbackCause =
              typeof rollbackCause === "object" &&
              rollbackCause !== null &&
              "cause" in rollbackCause
                ? rollbackCause.cause
                : undefined;
          }
          const protocolRefusal = rollbackCauses.find(
            Schema.is(ProviderAdapter.ProviderAdapterProtocolError),
          );
          assert.isDefined(
            protocolRefusal,
            `actual adapter refusal required, observed chain ${rollbackCauses.map((cause) => (typeof cause === "object" && cause !== null && "_tag" in cause ? String(cause._tag) : typeof cause)).join(" -> ")}`,
          );
          if (protocolRefusal !== undefined) {
            assert.include(protocolRefusal.detail, "while provider turn");
            assert.deepEqual(
              answer,
              { error: "rewind_refused", reason: protocolRefusal.detail },
              "route retains the actual adapter refusal reason",
            );
          }
          assert.deepEqual(interim.runs, before.runs);
          assert.deepEqual(interim.messages, before.messages);
          assert.deepEqual(interim.providerThreads, before.providerThreads);
          assert.equal(
            (yield* (yield* SqlClient.SqlClient)`SELECT * FROM throughline_rewind_cut WHERE thread_id=${threadId}`)
              .length,
            0,
            "refused adapter leaves no pending cut to recover later",
          );
        } else {
          assert.equal(
            interim.runs.find((row) => row.id === RunId.make("valid-boundary-run"))?.status,
            "rolled_back",
          );
          assert.isFalse(
            interim.messages.some((row) => row.runId === runId),
            "retained run is genuinely message-less",
          );
        }
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(pending);
        assert.isTrue(
          Exit.isSuccess(result),
          "still-valid capture must publish after route outcome",
        );
        const after = yield* projections.getThreadRecords(threadId, ["runs", "checkpoints"]);
        const captured = after.checkpoints.find((row) => row.runId === runId);
        assert.equal(captured?.status, "ready");
        assert.equal(after.runs.find((row) => row.id === runId)?.checkpointId, captured?.id);
        assert.equal(after.runs.find((row) => row.id === runId)?.status, "completed");
        assert.equal(
          state
            .publications()
            .filter(
              (row) =>
                row.event.type === "checkpoint.captured" &&
                row.event.payload.runId === runId &&
                row.event.payload.status === "ready",
            ).length,
          1,
        );
        if (keptLaterCheckpoint !== undefined)
          assert.deepEqual(
            after.checkpoints.find((row) => row.id === keptLaterCheckpoint.id),
            keptLaterCheckpoint,
            "newer retained checkpoint remains unchanged",
          );
        assert.equal(yield* fs.readFileString(path.join(state.cwd, "README.md")), workspaceBefore);
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined)),
        Effect.ensuring(Effect.promise(dispose)),
      );
    }),
  );

export const assertNewPostCutCapture = () =>
  fixture((state) =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { handler, dispose } = yield* makeControlledRewindHandler(state);
      yield* Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          handler(
            new Request(`http://fixture/throughline/threads/${threadId}/rewind`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: encodeRewindRequest({ messageId: MessageId.make("user") }),
            }),
          ),
        );
        assert.equal(response.status, 200);
        const cut = yield* projections.getThreadRecords(threadId, [
          "runs",
          "messages",
          "providerThreads",
        ]);
        assert.equal(cut.runs.find((row) => row.id === runId)?.status, "rolled_back");
        const fs = yield* FileSystem.FileSystem,
          path = yield* Path.Path;
        const adapter = yield* makeClaudeAdapterV2({
          instanceId: ProviderInstanceId.make("claude"),
          settings: yield* Schema.decodeEffect(ClaudeSettings)({}),
          environment: {},
          attachmentsDir: state.cwd,
          fileSystem: fs,
          path,
          crypto: yield* Crypto.Crypto,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          queryRunner: {
            allocateSessionId: Effect.die("pure intake must not allocate a native session"),
            open: () => Effect.die("pure intake must not run a provider"),
            forkSession: () => Effect.die("pure intake must not fork a provider"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const replayId = yield* (yield* Crypto.Crypto).randomUUIDv4;
        const replayName = `checkpoint-post-cut-worker-upmerge-${replayId}`;
        const prefix = `t3-orchestration-v2-replay-${replayName}-`,
          parent = path.dirname(state.cwd);
        const priorDirs = new Set(yield* fs.readDirectory(parent));
        const replay = ProviderReplayHarness.layerWithRegistry(
          { name: replayName },
          ProviderRegistry.layerFromAdapters([adapter]),
          {
            databaseLayer: Layer.succeed(SqlClient.SqlClient, yield* SqlClient.SqlClient),
            runEffectWorker: false,
          },
        );
        const realIntake = ThreadManagement.layer.pipe(Layer.provideMerge(replay));
        const created = yield* Effect.scoped(
          ThreadMessageIntake.sendToThread({
            projectId: ProjectId.make("project"),
            commandId: CommandId.make("genuine-post-cut-command"),
            threadId,
            messageId: MessageId.make("genuine-post-cut-message"),
            text: "genuinely new turn after exact cut",
            attachments: [],
            mode: "auto",
            createdBy: "user",
            creationSource: "web",
          }).pipe(Effect.provide(realIntake)),
        ).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              const owned = (yield* fs.readDirectory(parent)).filter(
                (name) => name.startsWith(prefix) && !priorDirs.has(name),
              );
              assert.equal(
                owned.length,
                1,
                "replay configuration must create exactly one owned fixture directory",
              );
              for (const name of owned) {
                const directory = path.join(parent, name);
                yield* fs.remove(directory, { recursive: true });
                assert.isFalse(
                  yield* fs.exists(directory),
                  "owned replay configuration removed after its graph scope closed",
                );
              }
            }).pipe(Effect.orDie),
          ),
        );
        assert.notEqual(created.run.id, runId);
        assert.isAbove(
          created.run.ordinal,
          1,
          "native intake must allocate above the existing cut run, not reuse its ordinal",
        );
        const current = yield* projections.getThreadRecords(threadId, [
          "runs",
          "nodes",
          "providerThreads",
          "checkpointScopes",
          "messages",
        ]);
        const added = current.runs.find((row) => row.id === created.run.id)!;
        const node = current.nodes.find((row) => row.id === added.rootNodeId);
        const scope = current.checkpointScopes.find((row) => row.id === node?.checkpointScopeId);
        assert.isDefined(node, "real intake must materialize the run root");
        assert.isDefined(scope, "real intake must materialize its checkpoint scope");
        assert.isNotNull(added.providerThreadId);
        if (node === undefined || scope === undefined || added.providerThreadId === null)
          return yield* Effect.die("post-cut capture input is incomplete");
        const provider = current.providerThreads.find((row) => row.id === added.providerThreadId)!;
        if (provider.providerSessionId === null || added.activeAttemptId === null)
          return yield* Effect.die(
            "real intake must materialize provider session and attempt identity",
          );
        const ingested = yield* (yield* Ingestor.ProviderEventIngestorV2).ingestNormalized({
          providerSessionId: provider.providerSessionId,
          providerInstanceId: provider.providerInstanceId,
          threadId,
          runId: added.id,
          writeIfRunCurrent: {
            runId: added.id,
            activeAttemptId: added.activeAttemptId,
            expectedStatus: added.status,
          },
          event: {
            type: "provider_thread.updated",
            driver: ProviderDriverKind.make("claudeAgent"),
            providerThread: provider,
          },
        });
        assert.equal(ingested.length, 1, "the new run's real ownership gate must commit");
        const now = yield* DateTime.now;
        yield* (yield* EventSink.EventSinkV2).write({
          events: [
            {
              id: EventId.make("post-cut-provider-completed-run"),
              type: "run.updated",
              threadId,
              runId: added.id,
              occurredAt: now,
              payload: { ...added, status: "waiting" },
            },
            {
              id: EventId.make("post-cut-provider-completed-root"),
              type: "node.updated",
              threadId,
              runId: added.id,
              occurredAt: now,
              payload: { ...node, status: "waiting" },
            },
          ],
        });
        yield* (yield* Capture.CheckpointCaptureServiceV2).execute({
          threadId,
          runId: added.id,
          scopeId: scope.id,
        });
        const after = yield* projections.getThreadRecords(threadId, [
          "runs",
          "checkpoints",
          "messages",
        ]);
        assert.equal(after.runs.find((row) => row.id === runId)?.status, "rolled_back");
        assert.equal(after.runs.find((row) => row.id === added.id)?.status, "completed");
        assert.equal(after.checkpoints.find((row) => row.runId === added.id)?.status, "ready");
        assert.isTrue(
          after.messages.some((row) => row.id === MessageId.make("genuine-post-cut-message")),
        );
      }).pipe(Effect.ensuring(Effect.promise(dispose)));
    }),
  );

export const assertOriginalRewindGuard = (
  guard: "missing" | "assistant" | "starting" | "running",
) =>
  fixture((state) =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2,
        projections = yield* ProjectionStore.ProjectionStoreV2;
      const seed = yield* projections.getThreadRecords(threadId, [
        "messages",
        "runs",
        "providerThreads",
      ]);
      const current = seed.runs[0]!;
      const event = (type: string, payload: unknown) =>
        Schema.decodeUnknownSync(OrchestrationV2StoredEvent)({
          sequence: 1,
          commandId: null,
          event: {
            id: `contention-guard-${nextEvent++}`,
            type,
            threadId,
            occurredAt: current.requestedAt,
            payload,
          },
        }).event;
      if (guard === "assistant")
        yield* sink.write({
          events: [event("message.updated", { ...seed.messages[0]!, role: "assistant" })],
        });
      if (guard === "starting" || guard === "running") {
        // V1 starting-session maps to an actual pending provider turn in V2;
        // run.status alone is not provider activity under the ratified R3 rule.
        yield* sink.write({
          events: [
            event("provider-turn.updated", {
              id: "guard-active-provider-turn",
              providerThreadId: seed.providerThreads[0]!.id,
              nodeId: current.rootNodeId,
              runAttemptId: null,
              nativeTurnRef: null,
              ordinal: 1,
              status: guard === "starting" ? "pending" : "running",
              startedAt: guard === "running" ? current.requestedAt : null,
              completedAt: null,
            }),
          ],
        });
      }
      const before = yield* projections.getThreadRecords(threadId, [
        "runs",
        "messages",
        "nodes",
        "providerThreads",
        "providerTurns",
        "checkpoints",
      ]);
      const store = yield* EventStore.EventStoreV2;
      const sequenceBefore = yield* store.latestSequence({ threadId });
      const fs = yield* FileSystem.FileSystem,
        path = yield* Path.Path;
      const workspaceBefore = yield* fs.readFileString(path.join(state.cwd, "README.md"));
      const transcriptBefore = yield* fs.readFileString(state.transcript);
      const { handler, dispose } = yield* makeControlledRewindHandler(state);
      yield* Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          handler(
            new Request(`http://fixture/throughline/threads/${threadId}/rewind`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: encodeRewindRequest({
                messageId: MessageId.make(guard === "missing" ? "missing" : "user"),
              }),
            }),
          ),
        );
        assert.equal(response.status, 409);
        const answer: unknown = yield* Effect.promise(() => response.json());
        assert.deepEqual(answer, {
          error: "rewind_refused",
          reason: guard === "missing" || guard === "assistant" ? "unknown-message" : "active-run",
        });
        assert.equal(
          yield* store.latestSequence({ threadId }),
          sequenceBefore,
          "guard refusal writes no orchestration events",
        );
        assert.deepEqual(
          yield* projections.getThreadRecords(threadId, [
            "runs",
            "messages",
            "nodes",
            "providerThreads",
            "providerTurns",
            "checkpoints",
          ]),
          before,
        );
        assert.equal(
          (yield* (yield* SqlClient.SqlClient)`SELECT * FROM throughline_rewind_cut WHERE thread_id=${threadId}`)
            .length,
          0,
        );
        assert.equal(yield* fs.readFileString(path.join(state.cwd, "README.md")), workspaceBefore);
        assert.equal(yield* fs.readFileString(state.transcript), transcriptBefore);
      }).pipe(Effect.ensuring(Effect.promise(dispose)));
    }),
  );

export const assertCaptureThenCut = () =>
  fixture((state) =>
    Effect.gen(function* () {
      const capture = yield* Capture.CheckpointCaptureServiceV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const fs = yield* FileSystem.FileSystem,
        path = yield* Path.Path;
      const now = yield* DateTime.now;
      const seed = yield* projections.getThreadRecords(threadId, [
        "runs",
        "nodes",
        "checkpointScopes",
        "providerThreads",
      ]);
      const current = seed.runs[0]!,
        node = seed.nodes[0]!,
        scope = seed.checkpointScopes[0]!,
        provider = seed.providerThreads[0]!;
      const earlierId = RunId.make("earlier-run"),
        earlierNode = NodeId.make("earlier-root"),
        earlierScopeId = CheckpointScopeId.make("earlier-scope");
      const earlierScope = { ...scope, id: earlierScopeId, runId: earlierId, nodeId: earlierNode };
      yield* sink.write({
        events: [
          {
            id: EventId.make("setup-ordinal-two"),
            type: "run.updated",
            threadId,
            runId,
            occurredAt: now,
            payload: { ...current, ordinal: 2 },
          },
          {
            id: EventId.make("setup-earlier-run"),
            type: "run.created",
            threadId,
            occurredAt: now,
            payload: {
              ...current,
              id: earlierId,
              ordinal: 1,
              rootNodeId: earlierNode,
              userMessageId: MessageId.make("earlier-message-not-stored"),
              status: "completed",
              completedAt: now,
            },
          },
          {
            id: EventId.make("setup-earlier-node"),
            type: "node.updated",
            threadId,
            runId: earlierId,
            occurredAt: now,
            payload: {
              ...node,
              id: earlierNode,
              runId: earlierId,
              rootNodeId: earlierNode,
              checkpointScopeId: earlierScopeId,
              status: "completed",
              completedAt: now,
            },
          },
          {
            id: EventId.make("setup-earlier-scope"),
            type: "checkpoint-scope.created",
            threadId,
            runId: earlierId,
            occurredAt: now,
            payload: earlierScope,
          },
          {
            id: EventId.make("setup-provider-ordinal-two"),
            type: "provider-thread.updated",
            threadId,
            occurredAt: now,
            payload: { ...provider, lastRunOrdinal: 2 },
          },
        ],
      });
      const earlier = yield* checkpoints.capture({
        scope: earlierScope,
        runId: earlierId,
        nodeId: earlierNode,
        ordinalWithinScope: 1,
        appRunOrdinal: 1,
        capturedAt: now,
      });
      // materializeBaselineCheckpoint reads existing refs; it does not create
      // a missing filesystem snapshot. Capture the ref before changing bytes.
      yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 1 });
      const baseline = yield* checkpoints.materializeBaselineCheckpoint({
        scope,
        ordinalWithinScope: 1,
      });
      yield* sink.write({
        events: [
          {
            id: EventId.make("setup-earlier-checkpoint"),
            type: "checkpoint.captured",
            threadId,
            runId: earlierId,
            occurredAt: now,
            payload: earlier,
          },
          {
            id: EventId.make("setup-current-baseline"),
            type: "checkpoint.captured",
            threadId,
            occurredAt: now,
            payload: baseline,
          },
        ],
      });
      yield* fs.writeFileString(path.join(state.cwd, "README.md"), "changed but retained bytes\n");
      yield* capture.execute({ threadId, runId, scopeId });
      const before = yield* projections.getThreadRecords(threadId, ["checkpoints"]);
      assert.equal(
        before.checkpoints.filter((row) => row.runId === runId && row.status === "ready").length,
        1,
      );
      const captured = before.checkpoints.find((row) => row.runId === runId)!;
      assert.isAbove(
        captured.files.length,
        0,
        "file preservation must not be proved on an empty diff",
      );
      assert.isAbove(
        state
          .publications()
          .filter(
            (row) =>
              row.event.type === "checkpoint.captured" &&
              row.event.payload.runId === runId &&
              row.event.payload.status === "ready",
          ).length,
        0,
        "publication witness must actually fire",
      );
      const { handler, dispose } = yield* makeControlledRewindHandler(state);
      yield* Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          handler(
            new Request(`http://fixture/throughline/threads/${threadId}/rewind`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: encodeRewindRequest({ messageId: MessageId.make("user") }),
            }),
          ),
        );
        assert.equal(response.status, 200);
        const after = yield* projections.getThreadRecords(threadId, ["runs", "checkpoints"]);
        assert.equal(after.runs.find((row) => row.id === runId)?.status, "rolled_back");
        assert.equal(
          after.checkpoints.filter((row) => row.runId === runId && row.status === "ready").length,
          0,
          "capture-first then exact cut must leave no live checkpoint on the removed run",
        );
        const stale = after.checkpoints.find((row) => row.id === captured.id);
        assert.isDefined(stale, "retirement must retain the row, not delete it");
        assert.equal(stale?.status, "stale");
        assert.equal(stale?.scopeId, captured.scopeId);
        assert.deepEqual(stale?.files, captured.files);
        assert.deepEqual(
          after.checkpoints.find((row) => row.id === earlier.id),
          earlier,
          "earlier-run checkpoint remains ready and byte-equivalent",
        );
        assert.equal(after.runs.find((row) => row.id === earlierId)?.status, "completed");
        assert.equal(
          yield* fs.readFileString(path.join(state.cwd, "README.md")),
          "changed but retained bytes\n",
        );
        const replay = yield* Effect.exit(
          sink.write({
            events: [
              {
                id: EventId.make("late-ready-replay"),
                type: "checkpoint.captured",
                threadId,
                runId,
                occurredAt: now,
                payload: captured,
              },
            ],
          }),
        );
        assert.isTrue(
          Exit.isFailure(replay),
          "a late ready replay cannot revive a stale checkpoint",
        );
        assert.equal(
          (yield* projections.getThreadRecords(threadId, ["checkpoints"])).checkpoints.find(
            (row) => row.id === captured.id,
          )?.status,
          "stale",
        );
      }).pipe(Effect.ensuring(Effect.promise(dispose)));
    }),
  );
