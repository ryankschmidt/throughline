import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it, vi } from "@effect/vitest";
import {
  MessageId,
  ThreadId,
  RunId,
  NodeId,
  EventId,
  ProviderThreadId,
  ClaudeSettings,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  makeClaudeAdapterV2,
  type ClaudeAgentSdkQueryOptions,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { v2Projection } from "../../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import { EventStoreV2 } from "../../orchestration-v2/EventStore.ts";
import { ProviderSessionManagerV2 } from "../../orchestration-v2/ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "../../orchestration-v2/RuntimePolicy.ts";
import * as ThreadCommandExecutor from "../../orchestration-v2/ThreadCommandExecutor.ts";
import { ExactMessageRewindV2, ExactMessageRewindError } from "./ExactMessageRewindV2.ts";
import { makeLayer } from "./ExactMessageRewindRuntime.ts";
import { resolveClaudeNativeTranscriptPath } from "../identity/native-lineage.ts";
import { observeEvents } from "../observation/EventSinkObservation.ts";

const threadId = ThreadId.make("thread");
const messageId = MessageId.make("selected");
const nativeSessionId = "00000000-0000-4000-8000-000000000001";
const initial = DateTime.makeUnsafe("2026-10-10T00:00:00Z");
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* runMigrations();
  const home = yield* fs.makeTempDirectoryScoped();
  const folder = path.join(home, "projects", "project");
  yield* fs.makeDirectory(folder, { recursive: true });
  const transcript = path.join(folder, `${nativeSessionId}.jsonl`);
  yield* fs.writeFileString(
    transcript,
    '{"uuid":"hook","parentUuid":null}\n{"uuid":"native-selected","parentUuid":"hook"}\n{"uuid":"later","parentUuid":"native-selected"}\n',
  );
  yield* sql`INSERT INTO throughline_thread_identity (thread_id, provider_thread_id, native_session_id, native_transcript_path) VALUES ('thread','provider',${nativeSessionId},${transcript})`;
  const projection = {
    thread: {
      id: threadId,
      activeProviderThreadId: "provider",
      modelSelection: { instanceId: "claude", model: "test" },
    },
    messages: [{ id: messageId, role: "user", runId: "selected-run", text: "selected" }],
    runs: [
      {
        id: "selected-run",
        ordinal: 1,
        status: "completed",
        providerThreadId: "provider",
        userMessageId: messageId,
        rootNodeId: "root",
        providerInstanceId: "claude",
        requestedAt: initial,
      },
    ],
    nodes: [{ id: "root", status: "completed", runId: "selected-run" }],
    attempts: [],
    providerTurns: [],
    providerSessions: [],
    providerThreads: [
      {
        id: "provider",
        driver: "claudeAgent",
        providerInstanceId: "claude",
        providerSessionId: "session",
        nativeThreadRef: { driver: "claudeAgent", nativeId: nativeSessionId, strength: "strong" },
        nativeConversationHeadRef: null,
        lastRunOrdinal: 1,
      },
    ],
    turnItems: [
      {
        type: "user_message",
        messageId,
        nodeId: "root",
        providerThreadId: "provider",
        nativeItemRef: { driver: "claudeAgent", nativeId: "native-selected" },
      },
    ],
    checkpoints: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const projections = new Map([[threadId, projection]]);
  const sdkOpens: Array<ClaudeAgentSdkQueryOptions> = [];
  const allocateSessionId = vi.fn(() => Effect.succeed("unexpected-new-session"));
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: home,
  });
  const actualAdapter = yield* makeClaudeAdapterV2({
    instanceId: ProviderInstanceId.make("claude"),
    settings: yield* Schema.decodeEffect(ClaudeSettings)({}),
    environment: {},
    attachmentsDir: home,
    fileSystem: fs,
    path,
    crypto: yield* Crypto.Crypto,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    queryRunner: {
      allocateSessionId: Effect.suspend(allocateSessionId),
      open: (input) =>
        Effect.sync(() => {
          sdkOpens.push(input.options);
          return {
            messages: Stream.never,
            offer: () => Effect.void,
            setModel: () => Effect.void,
            setPermissionMode: () => Effect.void,
            interrupt: Effect.void,
            close: Effect.void,
          };
        }),
      forkSession: () => Effect.die("rewind must never fork"),
      subagentLaunchToolUseId: () => Effect.succeed(null),
      assertComplete: Effect.void,
    },
  });
  const actualRuntime = yield* actualAdapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("session"),
    modelSelection: projection.thread.modelSelection,
    runtimePolicy,
    initialNativeThreadId: nativeSessionId,
  });
  let events: Array<OrchestrationV2DomainEvent> = [];
  let refusal = false;
  const rollback = vi.fn(
    (input: {
      providerThread: OrchestrationV2ThreadProjection["providerThreads"][number];
      target: { type: string; providerTurn?: { nativeTurnRef: { nativeId: string } } };
    }) =>
      Effect.gen(function* () {
        const cut = yield* sql`SELECT * FROM throughline_rewind_cut WHERE thread_id='thread'`;
        assert.equal(cut.length, 1, "cut is durable before adapter rollback");
        if (refusal) return yield* new ExactMessageRewindError({ reason: "provider-refused" });
        assert.equal(
          input.target.type,
          "provider_turn",
          "first prompt must not allocate a new session",
        );
        return yield* actualRuntime.rollbackThread(
          input as ProviderAdapter.ProviderAdapterV2RollbackThreadInput,
        );
      }),
  );
  const open = vi.fn(() => Effect.succeed({ rollbackThread: rollback } as never));
  const testLayer = makeLayer({
    resolveTranscriptPath: (sessionId) => resolveClaudeNativeTranscriptPath(sessionId, home),
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(SqlClient.SqlClient, sql),
        IdAllocator.layer,
        ThreadCommandExecutor.layer,
        Layer.mock(ProjectionStoreV2)({
          getThreadRecords: (threadId) => Effect.succeed(projections.get(threadId)!),
        }),
        Layer.mock(EventStoreV2)({ latestSequence: () => Effect.succeed(10) }),
        Layer.mock(RuntimePolicyV2)({ resolve: () => Effect.succeed({} as never) }),
        Layer.mock(ProviderSessionManagerV2)({ open }),
        Layer.mock(EventSinkV2)({
          write: (input) =>
            Effect.sync(() => {
              events.push(...input.events);
              for (const event of input.events) {
                const current = projections.get(event.threadId)!;
                if (event.type === "provider-thread.updated")
                  (current.providerThreads as Array<typeof event.payload>)[0] = event.payload;
                if (event.type === "run.updated") {
                  const index = current.runs.findIndex((run) => run.id === event.payload.id);
                  if (index >= 0)
                    (current.runs as Array<typeof event.payload>)[index] = event.payload;
                }
              }
              return input.events.map((event, index) => ({
                sequence: index + 1,
                commandId: null,
                event,
              }));
            }),
        }),
      ),
    ),
  );
  return {
    sql,
    fs,
    transcript,
    projection,
    projections,
    open,
    rollback,
    testLayer,
    actualRuntime,
    runtimePolicy,
    sdkOpens,
    allocateSessionId,
    events: () => events,
    clearEvents: () => {
      events = [];
    },
    refuse: () => {
      refusal = true;
    },
  };
});
const environment = Layer.mergeAll(
  NodeServices.layer,
  NodeSqliteClient.layer({ filename: ":memory:" }),
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeCrypto.layer,
);

for (const oldMessageId of ["selected", "different-old-message"]) {
  it.effect(
    `a new cut replaces a refused row for ${oldMessageId === "selected" ? "the same" : "a different"} message with real SQL`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.sql`INSERT INTO throughline_rewind_cut (thread_id,provider_thread_id,native_session_id,resume_at,target_message_id,target_run_ordinal,source_tip_run_ordinal,source_tip_sequence,recovery_state,refusal_reason) VALUES ('thread','provider',${nativeSessionId},'old',${oldMessageId},0,1,10,'refused','active-provider-changed')`;
        yield* Effect.gen(function* () {
          const service = yield* ExactMessageRewindV2;
          yield* service.recoverPendingCuts;
          yield* service.execute({ threadId, messageId });
        }).pipe(Effect.provide(f.testLayer));
        const rows = yield* f.sql<{
          recovery_state: string;
          refusal_reason: string | null;
          resume_at: string;
          target_message_id: string;
        }>`SELECT * FROM throughline_rewind_cut WHERE thread_id='thread'`;
        assert.equal(rows[0]?.recovery_state, "pending");
        assert.isNull(rows[0]?.refusal_reason);
        assert.equal(rows[0]?.resume_at, "hook");
        assert.equal(rows[0]?.target_message_id, messageId);
        assert.include(yield* f.fs.readFileString(f.transcript), '"uuid":"later"');
      }).pipe(Effect.provide(environment)),
  );
}

it.effect("a refused replacement preserves the previous cut and all native messages", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.sql`INSERT INTO throughline_rewind_cut (thread_id,provider_thread_id,native_session_id,resume_at,target_message_id,target_run_ordinal,source_tip_run_ordinal,source_tip_sequence,recovery_state,refusal_reason) VALUES ('thread','provider',${nativeSessionId},'old','selected',0,1,10,'refused','active-provider-changed')`;
    const before = yield* f.sql`SELECT * FROM throughline_rewind_cut`;
    const transcript = yield* f.fs.readFileString(f.transcript);
    f.refuse();
    const error = yield* Effect.flatMap(ExactMessageRewindV2, (service) =>
      service.execute({ threadId, messageId }),
    ).pipe(Effect.flip, Effect.provide(f.testLayer));
    assert.equal(error.reason, "provider-refused");
    assert.deepStrictEqual(yield* f.sql`SELECT * FROM throughline_rewind_cut`, before);
    assert.equal(yield* f.fs.readFileString(f.transcript), transcript);
    assert.deepStrictEqual(f.events(), []);
  }).pipe(Effect.provide(environment)),
);

it.effect("startup readiness finishes after the actual pending-cut recovery", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.sql`INSERT INTO throughline_rewind_cut (thread_id,provider_thread_id,native_session_id,resume_at,target_message_id,target_run_ordinal,source_tip_run_ordinal,source_tip_sequence) VALUES ('thread','provider',${nativeSessionId},'hook','selected',0,1,10)`;
    yield* Effect.gen(function* () {
      const service = yield* ExactMessageRewindV2;
      assert.isTrue(yield* service.recoveryInProgress(threadId));
      yield* service.recoverPendingCuts;
      assert.isFalse(yield* service.recoveryInProgress(threadId));
    }).pipe(Effect.provide(f.testLayer));
    assert.equal(
      (yield* f.sql<{
        recovery_state: string;
      }>`SELECT recovery_state FROM throughline_rewind_cut`)[0]?.recovery_state,
      "recovered",
    );
  }).pipe(Effect.provide(environment)),
);

it.effect("rewinds the first Claude prompt in place with zero file checkpoints", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const ack = yield* Effect.flatMap(ExactMessageRewindV2, (service) =>
      service.execute({ threadId, messageId }),
    ).pipe(Effect.provide(f.testLayer));
    assert.equal(ack.messageId, messageId);
    assert.equal(f.open.mock.calls.length, 1);
    const threadEvent = f.events().find((event) => event.type === "provider-thread.updated");
    assert.equal(threadEvent?.payload.nativeThreadRef?.nativeId, nativeSessionId);
    assert.equal(threadEvent?.payload.nativeConversationHeadRef?.nativeId, "hook");
    assert.equal(threadEvent?.payload.lastRunOrdinal, null);
    assert.equal(f.events().filter((event) => event.type === "run.updated").length, 1);
    assert.isFalse(f.events().some((event) => event.type === "checkpoint.captured"));
    assert.include(
      yield* f.fs.readFileString(f.transcript),
      '"uuid":"later"',
      "native history is not deleted",
    );
  }).pipe(Effect.provide(environment)),
);

it.effect("unknown native markers refuse before opening or trimming", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.fs.writeFileString(f.transcript, '{"uuid":"other","parentUuid":"hook"}\n');
    const error = yield* Effect.flatMap(ExactMessageRewindV2, (service) =>
      service.execute({ threadId, messageId }),
    ).pipe(Effect.flip, Effect.provide(f.testLayer));
    assert.equal(error.reason, "native-parent-unavailable");
    assert.equal(f.open.mock.calls.length, 0);
    assert.deepStrictEqual(f.events(), []);
    assert.equal((yield* f.sql`SELECT * FROM throughline_rewind_cut`).length, 0);
  }).pipe(Effect.provide(environment)),
);

it.effect("provider refusal leaves no pending cut that could trim history on restart", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.refuse();
    const error = yield* Effect.flatMap(ExactMessageRewindV2, (service) =>
      service.execute({ threadId, messageId }),
    ).pipe(Effect.flip, Effect.provide(f.testLayer));
    assert.equal(error.reason, "provider-refused");
    assert.deepStrictEqual(f.events(), []);
    assert.equal((yield* f.sql`SELECT * FROM throughline_rewind_cut`).length, 0);
  }).pipe(Effect.provide(environment)),
);

it.effect("restart replays a pending cut with the same session and run boundary", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.sql`INSERT INTO throughline_rewind_cut (thread_id,provider_thread_id,native_session_id,resume_at,target_message_id,target_run_ordinal,source_tip_run_ordinal,source_tip_sequence) VALUES ('thread','provider',${nativeSessionId},'hook','selected',0,1,10)`;
    yield* Effect.flatMap(ExactMessageRewindV2, (service) => service.recoverPendingCuts).pipe(
      Effect.provide(f.testLayer),
    );
    const threadEvent = f.events().find((event) => event.type === "provider-thread.updated");
    assert.equal(threadEvent?.payload.nativeThreadRef?.nativeId, nativeSessionId);
    assert.equal(threadEvent?.payload.nativeConversationHeadRef?.nativeId, "hook");
    assert.equal(threadEvent?.payload.lastRunOrdinal, null);
    assert.equal(
      f.open.mock.calls.length,
      0,
      "recovery sets the next lazy resume cursor without launching a provider",
    );
  }).pipe(Effect.provide(environment)),
);

it.effect("restart preserves work created after the durable cut", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const newer = {
      ...f.projection.runs[0]!,
      id: RunId.make("next-run"),
      ordinal: 2,
      requestedAt: DateTime.makeUnsafe("2099-01-01T00:00:00Z"),
    };
    (f.projection.runs as Array<typeof newer>).push(newer);
    yield* f.sql`INSERT INTO throughline_rewind_cut (thread_id,provider_thread_id,native_session_id,resume_at,target_message_id,target_run_ordinal,source_tip_run_ordinal,source_tip_sequence) VALUES ('thread','provider',${nativeSessionId},'hook','selected',0,1,10)`;
    yield* Effect.flatMap(ExactMessageRewindV2, (service) => service.recoverPendingCuts).pipe(
      Effect.provide(f.testLayer),
    );
    assert.deepStrictEqual(
      f
        .events()
        .filter((event) => event.type === "run.updated")
        .map((event) => event.payload.id),
      ["selected-run"],
    );
  }).pipe(Effect.provide(environment)),
);

it.effect("rewinds again and again in the same native session", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.flatMap(ExactMessageRewindV2, (service) =>
      service.execute({ threadId, messageId }),
    ).pipe(Effect.provide(f.testLayer));
    const priorRun = f.projection.runs[0]!;
    const nextMessageId = MessageId.make("next");
    const nextRun = {
      ...priorRun,
      id: RunId.make("next-run"),
      ordinal: 2,
      userMessageId: nextMessageId,
      status: "completed" as const,
      requestedAt: DateTime.makeUnsafe("2026-10-11T00:00:00Z"),
    };
    (f.projection.runs as Array<typeof nextRun>).push(nextRun);
    (f.projection.messages as Array<OrchestrationV2ThreadProjection["messages"][number]>).push({
      ...f.projection.messages[0]!,
      id: nextMessageId,
      runId: nextRun.id,
    });
    (f.projection.turnItems as Array<OrchestrationV2ThreadProjection["turnItems"][number]>).push({
      ...f.projection.turnItems[0]!,
      messageId: nextMessageId,
      nativeItemRef: { driver: "claudeAgent", nativeId: "native-next" },
    } as OrchestrationV2ThreadProjection["turnItems"][number]);
    yield* f.fs.writeFileString(
      f.transcript,
      (yield* f.fs.readFileString(f.transcript)) + '{"uuid":"native-next","parentUuid":"hook"}\n',
    );
    yield* Effect.flatMap(ExactMessageRewindV2, (service) =>
      service.execute({ threadId, messageId: nextMessageId }),
    ).pipe(Effect.provide(f.testLayer));
    assert.equal(f.rollback.mock.calls.length, 2);
    assert.equal(f.projection.providerThreads[0]?.nativeThreadRef?.nativeId, nativeSessionId);
    assert.isTrue(f.projection.runs.every((run) => run.status === "rolled_back"));
  }).pipe(Effect.provide(environment)),
);

it.effect("a later exact-message rollback cuts at the right message", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const selected = { ...f.projection.runs[0]!, ordinal: 2 };
    const earlier = {
      ...selected,
      id: RunId.make("before-run"),
      ordinal: 1,
      userMessageId: MessageId.make("before"),
      rootNodeId: NodeId.make("earlier-root"),
    };
    (f.projection.runs as Array<typeof selected>).splice(0, 1, earlier, selected);
    yield* f.fs.writeFileString(
      f.transcript,
      '{"uuid":"hook","parentUuid":null}\n{"uuid":"previous-native","parentUuid":"hook"}\n{"uuid":"native-selected","parentUuid":"previous-native"}\n',
    );
    yield* Effect.flatMap(ExactMessageRewindV2, (service) =>
      service.execute({ threadId, messageId }),
    ).pipe(Effect.provide(f.testLayer));
    assert.equal(
      f.projection.providerThreads[0]?.nativeConversationHeadRef?.nativeId,
      "previous-native",
    );
    assert.equal(f.projection.providerThreads[0]?.lastRunOrdinal, 1);
    assert.equal(f.projection.runs.find((run) => run.id === earlier.id)?.status, "completed");
    assert.equal(f.projection.runs.find((run) => run.id === selected.id)?.status, "rolled_back");
  }).pipe(Effect.provide(environment)),
);

it.effect("refuses a message it cannot line up with the saved markers", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    (f.projection.turnItems as Array<OrchestrationV2ThreadProjection["turnItems"][number]>).splice(
      0,
    );
    const error = yield* Effect.flatMap(ExactMessageRewindV2, (service) =>
      service.execute({ threadId, messageId }),
    ).pipe(Effect.flip, Effect.provide(f.testLayer));
    assert.equal(error.reason, "native-message-unavailable");
    assert.equal(f.open.mock.calls.length, 0);
    assert.deepStrictEqual(f.events(), []);
  }).pipe(Effect.provide(environment)),
);

it.effect("keeps the cut through a restart until the next reply commits it", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.sql`INSERT INTO throughline_rewind_cut (thread_id,provider_thread_id,native_session_id,resume_at,target_message_id,target_run_ordinal,source_tip_run_ordinal,source_tip_sequence) VALUES ('thread','provider',${nativeSessionId},'hook','selected',0,1,10)`;
    yield* Effect.flatMap(ExactMessageRewindV2, (service) => service.recoverPendingCuts).pipe(
      Effect.provide(f.testLayer),
    );
    const replay = Effect.fnUntraced(function* (ordinal: number, sequence: number) {
      const id = EventId.make(`assistant-reply:${sequence}`);
      yield* f.sql`INSERT OR REPLACE INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,provider_thread_id,status,requested_at,payload_json) VALUES ('next-run','thread',${ordinal},'claudeAgent','provider','completed','2026-10-10T00:00:00Z','{}')`;
      yield* f.sql`INSERT INTO orchestration_events (sequence,event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json) VALUES (${sequence},${id},'thread','thread',${sequence},'message.updated','2026-10-10T00:00:00Z','provider','{}','{}')`;
      yield* observeEvents([
        {
          event: {
            type: "message.updated",
            id,
            threadId,
            occurredAt: initial,
            payload: {
              id: MessageId.make("assistant"),
              threadId,
              runId: RunId.make("next-run"),
              nodeId: NodeId.make("root"),
              role: "assistant",
              text: "reply",
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "provider",
              createdAt: initial,
              updatedAt: initial,
            },
          },
        },
      ]);
    });
    yield* replay(1, 9);
    assert.isNull(
      (yield* f.sql<{
        committed_at: string | null;
      }>`SELECT committed_at FROM throughline_rewind_cut`)[0]?.committed_at,
    );
    yield* replay(2, 11);
    assert.isNotNull(
      (yield* f.sql<{
        committed_at: string | null;
      }>`SELECT committed_at FROM throughline_rewind_cut`)[0]?.committed_at,
    );
  }).pipe(Effect.provide(environment)),
);

it.effect(
  "the upstream Claude adapter opens the next SDK turn on the same session at the exact cut",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.flatMap(ExactMessageRewindV2, (service) =>
        service.execute({ threadId, messageId }),
      ).pipe(Effect.provide(f.testLayer));
      yield* f.actualRuntime.startTurn({
        appThread: {
          ...v2Projection.thread,
          id: threadId,
          modelSelection: f.projection.thread.modelSelection,
        },
        threadId,
        runId: RunId.make("new-sdk-run"),
        runOrdinal: 2,
        providerTurnOrdinal: 2,
        attemptId: RunAttemptId.make("new-sdk-attempt"),
        rootNodeId: NodeId.make("new-sdk-root"),
        providerThread: f.projection.providerThreads[0]!,
        message: {
          messageId: MessageId.make("new-sdk-message"),
          text: "after rewind",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: f.projection.thread.modelSelection,
        runtimePolicy: f.runtimePolicy,
      });
      assert.equal(f.sdkOpens.length, 1);
      assert.equal(f.sdkOpens[0]?.resume, nativeSessionId);
      assert.equal(f.sdkOpens[0]?.resumeSessionAt, "hook");
      assert.equal(f.allocateSessionId.mock.calls.length, 0);
    }).pipe(Effect.provide(environment)),
);

it.effect("first rewind discovers its transcript without a prior identity GET", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.sql`UPDATE throughline_thread_identity SET native_transcript_path=NULL`;
    const ack = yield* Effect.flatMap(ExactMessageRewindV2, (service) =>
      service.execute({ threadId, messageId }),
    ).pipe(Effect.provide(f.testLayer));
    assert.equal(ack.messageId, messageId);
    assert.equal(f.projection.providerThreads[0]?.nativeThreadRef?.nativeId, nativeSessionId);
    assert.equal(f.projection.providerThreads[0]?.nativeConversationHeadRef?.nativeId, "hook");
  }).pipe(Effect.provide(environment)),
);

it.effect(
  "restart cannot roll back post-cut work whose requested time is earlier than the server clock",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.flatMap(ExactMessageRewindV2, (service) =>
        service.execute({ threadId, messageId }),
      ).pipe(Effect.provide(f.testLayer));
      const newer = {
        ...f.projection.runs[0]!,
        id: RunId.make("post-cut-clock-skew"),
        ordinal: 2,
        status: "completed" as const,
        requestedAt: initial,
      };
      (f.projection.runs as Array<typeof newer>).push(newer);
      yield* Effect.flatMap(ExactMessageRewindV2, (service) => service.recoverPendingCuts).pipe(
        Effect.provide(f.testLayer),
      );
      assert.equal(f.projection.runs.find((run) => run.id === newer.id)?.status, "completed");
    }).pipe(Effect.provide(environment)),
);

it.effect("the persisted source tip preserves post-cut ordinals while trimming pre-cut work", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const newer = {
      ...f.projection.runs[0]!,
      id: RunId.make("above-tip"),
      ordinal: 2,
      requestedAt: initial,
    };
    (f.projection.runs as Array<typeof newer>).push(newer);
    yield* f.sql`INSERT INTO throughline_rewind_cut (thread_id,provider_thread_id,native_session_id,resume_at,target_message_id,target_run_ordinal,source_tip_run_ordinal,source_tip_sequence) VALUES ('thread','provider',${nativeSessionId},'hook','selected',0,1,10)`;
    yield* Effect.flatMap(ExactMessageRewindV2, (service) => service.recoverPendingCuts).pipe(
      Effect.provide(f.testLayer),
    );
    assert.equal(f.projection.runs.find((run) => run.id === "selected-run")?.status, "rolled_back");
    assert.equal(f.projection.runs.find((run) => run.id === newer.id)?.status, "completed");
  }).pipe(Effect.provide(environment)),
);

it.effect("one stale provider cut refuses only its thread while another pending cut recovers", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const secondThreadId = ThreadId.make("thread-b");
    const secondProviderId = ProviderThreadId.make("provider-b");
    const second = {
      ...f.projection,
      thread: {
        ...f.projection.thread,
        id: secondThreadId,
        activeProviderThreadId: secondProviderId,
      },
      providerThreads: f.projection.providerThreads.map((row) => ({
        ...row,
        id: secondProviderId,
      })),
      runs: f.projection.runs.map((row) => ({ ...row, providerThreadId: secondProviderId })),
    };
    f.projections.set(secondThreadId, second);
    f.projections.set(threadId, {
      ...f.projection,
      thread: { ...f.projection.thread, activeProviderThreadId: ProviderThreadId.make("switched") },
    });
    yield* f.sql`INSERT INTO throughline_rewind_cut (thread_id,provider_thread_id,native_session_id,resume_at,target_message_id,target_run_ordinal,source_tip_run_ordinal,source_tip_sequence) VALUES ('thread','provider',${nativeSessionId},'hook','selected',0,1,10), ('thread-b','provider-b',${nativeSessionId},'hook','selected',0,1,10)`;
    yield* Effect.flatMap(ExactMessageRewindV2, (service) => service.recoverPendingCuts).pipe(
      Effect.provide(f.testLayer),
    );
    const states =
      yield* f.sql`SELECT thread_id,recovery_state,refusal_reason,committed_at FROM throughline_rewind_cut ORDER BY thread_id`;
    assert.deepStrictEqual(states, [
      {
        thread_id: "thread",
        recovery_state: "refused",
        refusal_reason: "active-provider-changed",
        committed_at: null,
      },
      {
        thread_id: "thread-b",
        recovery_state: "recovered",
        refusal_reason: null,
        committed_at: null,
      },
    ]);
    assert.equal(f.projection.runs[0]?.status, "completed");
    assert.equal(second.runs[0]?.status, "rolled_back");
  }).pipe(Effect.provide(environment)),
);

it.effect(
  "startup with one malformed cut resolves and leaves ordinary turn execution available",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sql`INSERT INTO throughline_rewind_cut (thread_id,provider_thread_id,native_session_id,resume_at,target_message_id,target_run_ordinal,source_tip_run_ordinal,source_tip_sequence) VALUES ('thread','provider',${nativeSessionId},'hook',NULL,0,1,10)`;
      yield* Effect.flatMap(ExactMessageRewindV2, (service) => service.recoverPendingCuts).pipe(
        Effect.provide(f.testLayer),
      );
      assert.equal(
        (yield* f.sql<{
          recovery_state: string;
        }>`SELECT recovery_state FROM throughline_rewind_cut`)[0]?.recovery_state,
        "refused",
      );
      yield* f.actualRuntime.startTurn({
        appThread: {
          ...v2Projection.thread,
          id: threadId,
          modelSelection: f.projection.thread.modelSelection,
        },
        threadId,
        runId: RunId.make("ordinary-after-refusal"),
        runOrdinal: 2,
        providerTurnOrdinal: 2,
        attemptId: RunAttemptId.make("ordinary-after-refusal"),
        rootNodeId: NodeId.make("ordinary-after-refusal"),
        providerThread: f.projection.providerThreads[0]!,
        message: {
          messageId: MessageId.make("ordinary-after-refusal"),
          text: "ordinary turn",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: f.projection.thread.modelSelection,
        runtimePolicy: f.runtimePolicy,
      });
      assert.equal(
        f.sdkOpens.length,
        1,
        "the real V2 adapter still accepts an ordinary turn after refusal",
      );
      assert.equal(f.projection.runs[0]?.status, "completed");
    }).pipe(Effect.provide(environment)),
);

it.effect("rewinds a compacted session in place and keeps its markers", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const transcript =
      '{"uuid":"precompact","parentUuid":"history"}\n{"uuid":"compact-marker","parentUuid":"precompact","type":"system"}\n{"uuid":"native-selected","parentUuid":"compact-marker"}\n';
    yield* f.fs.writeFileString(f.transcript, transcript);
    yield* Effect.flatMap(ExactMessageRewindV2, (service) =>
      service.execute({ threadId, messageId }),
    ).pipe(Effect.provide(f.testLayer));
    assert.equal(
      f.projection.providerThreads[0]?.nativeConversationHeadRef?.nativeId,
      "compact-marker",
    );
    assert.equal(f.projection.providerThreads[0]?.nativeThreadRef?.nativeId, nativeSessionId);
    assert.equal(yield* f.fs.readFileString(f.transcript), transcript);
  }).pipe(Effect.provide(environment)),
);

it.effect("refuses a first-message rewind when nothing precedes it and keeps the session", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.fs.writeFileString(f.transcript, '{"uuid":"native-selected","parentUuid":null}\n');
    const error = yield* Effect.flatMap(ExactMessageRewindV2, (service) =>
      service.execute({ threadId, messageId }),
    ).pipe(Effect.flip, Effect.provide(f.testLayer));
    assert.equal(error.reason, "native-parent-unavailable");
    assert.equal(f.open.mock.calls.length, 0);
    assert.equal(f.projection.providerThreads[0]?.nativeThreadRef?.nativeId, nativeSessionId);
    assert.deepStrictEqual(f.events(), []);
  }).pipe(Effect.provide(environment)),
);

it.effect("restores the prior durable cut when a subsequent provider rewind refuses", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.sql`INSERT INTO throughline_rewind_cut (thread_id,provider_thread_id,native_session_id,resume_at,target_message_id,target_run_ordinal,source_tip_run_ordinal,source_tip_sequence,created_at) VALUES ('thread','provider',${nativeSessionId},'prior','prior-message',1,1,10,'2026-10-10T00:00:00Z')`;
    const before = yield* f.sql`SELECT * FROM throughline_rewind_cut`;
    f.refuse();
    yield* Effect.flatMap(ExactMessageRewindV2, (service) =>
      service.execute({ threadId, messageId }),
    ).pipe(Effect.flip, Effect.provide(f.testLayer));
    assert.deepStrictEqual(yield* f.sql`SELECT * FROM throughline_rewind_cut`, before);
  }).pipe(Effect.provide(environment)),
);
