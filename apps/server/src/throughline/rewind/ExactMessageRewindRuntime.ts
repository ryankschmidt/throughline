import {
  CheckpointId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  ProviderTurnId,
  ThreadId,
  latestProviderTurnForAttempt,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import { EventStoreV2 } from "../../orchestration-v2/EventStore.ts";
import { ProviderSessionManagerV2 } from "../../orchestration-v2/ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "../../orchestration-v2/RuntimePolicy.ts";
import { ThreadCommandExecutor } from "../../orchestration-v2/ThreadCommandExecutor.ts";
import { readClaudeParentUuid } from "./claudeTranscriptParent.ts";
import { resolveClaudeNativeTranscriptPath } from "../identity/native-lineage.ts";
import {
  ExactMessageRewindV2,
  ExactMessageRewindError,
  resolveExactMessageTarget,
  type ExactMessageRewindInput,
} from "./ExactMessageRewindV2.ts";

interface PendingCut {
  readonly thread_id: string;
  readonly provider_thread_id: string;
  readonly native_session_id: string;
  readonly resume_at: string;
  readonly target_message_id: string | null;
  readonly target_run_ordinal: number | null;
  readonly source_tip_run_ordinal: number;
  readonly source_tip_sequence: number;
  readonly recovery_state: "pending" | "recovered" | "refused";
  readonly refusal_reason: string | null;
  readonly created_at: string;
  readonly committed_at: string | null;
}

export const makeLayer = (
  options: {
    readonly resolveTranscriptPath?: (sessionId: string) => Promise<string | undefined>;
  } = {},
) =>
  Layer.effect(
    ExactMessageRewindV2,
    Effect.gen(function* () {
      const projections = yield* ProjectionStoreV2;
      const sink = yield* EventSinkV2;
      const eventStore = yield* EventStoreV2;
      const sessions = yield* ProviderSessionManagerV2;
      const policy = yield* RuntimePolicyV2;
      const commands = yield* ThreadCommandExecutor;
      const ids = yield* IdAllocator.IdAllocatorV2;
      const sql = yield* SqlClient.SqlClient;
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const findTranscript =
        options.resolveTranscriptPath ??
        ((sessionId: string) =>
          resolveClaudeNativeTranscriptPath(sessionId, process.env.CLAUDE_CONFIG_DIR));
      const makeEvent = <E extends OrchestrationV2DomainEvent>(event: Omit<E, "id">) =>
        ids.allocate
          .event({ threadId: event.threadId })
          .pipe(Effect.map((id) => ({ ...event, id }) as E));
      let startupRecoveryFinished = false;
      const recoveredThreads = new Set<string>();

      const recoverPendingCuts = Effect.gen(function* () {
        const cuts =
          yield* sql<PendingCut>`SELECT * FROM throughline_rewind_cut WHERE committed_at IS NULL AND recovery_state <> 'refused'`;
        yield* Effect.forEach(
          cuts,
          (initial) =>
            commands
              .withLock(
                ThreadId.make(initial.thread_id),
                Effect.gen(function* () {
                  // Re-read under the same command lock: another cut may have replaced the scanned row.
                  const rows =
                    yield* sql<PendingCut>`SELECT * FROM throughline_rewind_cut WHERE thread_id=${initial.thread_id} AND committed_at IS NULL AND recovery_state <> 'refused'`;
                  const cut = rows[0];
                  if (cut === undefined) return;
                  const threadId = ThreadId.make(cut.thread_id);
                  const outcome = yield* Effect.exit(
                    Effect.gen(function* () {
                      const records = yield* projections.getThreadRecords(threadId, [
                        "providerThreads",
                        "runs",
                        "nodes",
                        "messages",
                        "checkpoints",
                      ]);
                      const providerThread = records.providerThreads.find(
                        (row) => row.id === cut.provider_thread_id,
                      );
                      if (
                        providerThread === undefined ||
                        records.thread.activeProviderThreadId !== providerThread.id
                      )
                        return yield* new ExactMessageRewindError({
                          reason: "active-provider-changed",
                        });
                      if (providerThread.nativeThreadRef?.nativeId !== cut.native_session_id)
                        return yield* new ExactMessageRewindError({
                          reason: "native-session-changed",
                        });
                      if (
                        cut.target_run_ordinal === null ||
                        cut.target_message_id === null ||
                        !Number.isSafeInteger(cut.source_tip_run_ordinal) ||
                        !Number.isSafeInteger(cut.source_tip_sequence) ||
                        cut.source_tip_sequence < 0 ||
                        cut.source_tip_run_ordinal < cut.target_run_ordinal ||
                        !records.messages.some(
                          (message) =>
                            message.id === cut.target_message_id && message.role === "user",
                        )
                      )
                        return yield* new ExactMessageRewindError({
                          reason: "pending-cut-boundary-unavailable",
                        });
                      const staleRuns = records.runs.filter(
                        (run) =>
                          run.ordinal > cut.target_run_ordinal! &&
                          run.ordinal <= cut.source_tip_run_ordinal &&
                          run.status !== "rolled_back",
                      );
                      if (
                        providerThread.nativeConversationHeadRef?.nativeId === cut.resume_at &&
                        staleRuns.length === 0
                      )
                        return;
                      // Event time is the recorded cut time, never a wall-clock input to recovery ordering.
                      const now = yield* Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString)(
                        cut.created_at,
                      );
                      const event = yield* makeEvent({
                        type: "provider-thread.updated",
                        threadId,
                        driver: providerThread.driver,
                        providerInstanceId: providerThread.providerInstanceId,
                        occurredAt: now,
                        payload: {
                          ...providerThread,
                          ...(providerThread.lastRunOrdinal !== null &&
                          providerThread.lastRunOrdinal <= cut.source_tip_run_ordinal
                            ? {
                                lastRunOrdinal:
                                  cut.target_run_ordinal === 0 ? null : cut.target_run_ordinal,
                              }
                            : {}),
                          nativeConversationHeadRef: {
                            driver: providerThread.driver,
                            nativeId: cut.resume_at,
                            strength: "strong",
                          },
                          updatedAt: now,
                        },
                      });
                      const events: Array<OrchestrationV2DomainEvent> = [event];
                      for (const run of staleRuns) {
                        for (const checkpoint of records.checkpoints.filter(
                          (row) => row.runId === run.id && row.status === "ready",
                        )) {
                          events.push(
                            yield* makeEvent({
                              type: "checkpoint.captured",
                              threadId,
                              runId: run.id,
                              nodeId: checkpoint.nodeId,
                              driver: providerThread.driver,
                              providerInstanceId: run.providerInstanceId,
                              occurredAt: now,
                              payload: { ...checkpoint, status: "stale" },
                            }),
                          );
                        }
                        events.push(
                          yield* makeEvent({
                            type: "run.updated",
                            threadId,
                            runId: run.id,
                            providerInstanceId: run.providerInstanceId,
                            occurredAt: now,
                            payload: { ...run, status: "rolled_back", completedAt: now },
                          }),
                        );
                        const node = records.nodes.find((node) => node.id === run.rootNodeId);
                        if (node !== undefined)
                          events.push(
                            yield* makeEvent({
                              type: "node.updated",
                              threadId,
                              runId: run.id,
                              nodeId: node.id,
                              providerInstanceId: run.providerInstanceId,
                              occurredAt: now,
                              payload: { ...node, status: "rolled_back", completedAt: now },
                            }),
                          );
                      }
                      yield* sink.write({ events });
                    }),
                  );
                  if (Exit.isSuccess(outcome))
                    yield* sql`UPDATE throughline_rewind_cut SET recovery_state='recovered', refusal_reason=NULL WHERE thread_id=${threadId} AND committed_at IS NULL`;
                  else {
                    const cause = Cause.squash(outcome.cause);
                    const reason = Schema.is(ExactMessageRewindError)(cause)
                      ? cause.reason
                      : "pending-cut-recovery-failed";
                    yield* sql`UPDATE throughline_rewind_cut SET recovery_state='refused', refusal_reason=${reason} WHERE thread_id=${threadId} AND committed_at IS NULL`;
                    yield* Effect.logWarning("ThroughLine rewind cut refused during recovery", {
                      threadId,
                      reason,
                    });
                  }
                }),
              )
              .pipe(
                Effect.catchCause(() =>
                  Effect.logWarning("ThroughLine rewind recovery row could not be recorded", {
                    threadId: initial.thread_id,
                  }),
                ),
                Effect.ensuring(
                  Effect.sync(() => {
                    recoveredThreads.add(initial.thread_id);
                  }),
                ),
              ),
          { discard: true },
        );
      }).pipe(
        Effect.catchCause(() =>
          Effect.logWarning(
            "ThroughLine rewind recovery scan unavailable; rewind remains fail-closed",
          ),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            startupRecoveryFinished = true;
          }),
        ),
      );

      const execute = (input: ExactMessageRewindInput) =>
        commands
          .withLock(
            input.threadId,
            Effect.gen(function* () {
              const records = yield* projections.getThreadRecords(input.threadId, [
                "messages",
                "runs",
                "attempts",
                "providerThreads",
                "providerTurns",
                "providerSessions",
                "nodes",
                "turnItems",
                "checkpoints",
              ]);
              const selection = yield* Effect.try({
                try: () => resolveExactMessageTarget(records, input),
                catch: (cause) =>
                  Schema.is(ExactMessageRewindError)(cause)
                    ? cause
                    : new ExactMessageRewindError({ reason: "invalid-boundary" }),
              });
              const providerThread = records.providerThreads.find(
                (row) => row.id === selection.providerThread.id,
              )!;
              const nativeSessionId = providerThread.nativeThreadRef?.nativeId;
              if (providerThread.providerSessionId === null || nativeSessionId == null)
                return yield* new ExactMessageRewindError({ reason: "native-session-unavailable" });
              let target: ProviderAdapter.ProviderAdapterV2RollbackTarget;
              let resumeAt: string | undefined;
              if (providerThread.driver === "claudeAgent") {
                const item = records.turnItems.find(
                  (item) =>
                    item.type === "user_message" &&
                    item.messageId === input.messageId &&
                    item.providerThreadId === providerThread.id,
                );
                const nativeMessageId = item?.nativeItemRef?.nativeId;
                if (
                  nativeMessageId == null ||
                  item?.nativeItemRef?.driver !== providerThread.driver
                )
                  return yield* new ExactMessageRewindError({
                    reason: "native-message-unavailable",
                  });
                const identity = yield* sql<{
                  native_transcript_path: string | null;
                }>`SELECT native_transcript_path FROM throughline_thread_identity WHERE thread_id = ${input.threadId} AND provider_thread_id = ${providerThread.id} AND native_session_id = ${nativeSessionId}`;
                const transcript =
                  identity[0]?.native_transcript_path ??
                  (yield* Effect.tryPromise({
                    try: () => findTranscript(nativeSessionId),
                    catch: () =>
                      new ExactMessageRewindError({ reason: "native-transcript-unavailable" }),
                  }));
                if (transcript == null || path.basename(transcript) !== `${nativeSessionId}.jsonl`)
                  return yield* new ExactMessageRewindError({
                    reason: "native-transcript-unavailable",
                  });
                resumeAt = yield* readClaudeParentUuid(
                  path.dirname(path.dirname(path.dirname(transcript))),
                  nativeSessionId,
                  nativeMessageId,
                ).pipe(
                  Effect.provideService(FileSystem.FileSystem, fileSystem),
                  Effect.provideService(Path.Path, path),
                );
                if (resumeAt === undefined)
                  return yield* new ExactMessageRewindError({
                    reason: "native-parent-unavailable",
                  });
                const nodeId =
                  records.runs.find((run) => run.id === selection.selectedRun.id)?.rootNodeId ??
                  item?.nodeId;
                if (nodeId == null)
                  return yield* new ExactMessageRewindError({ reason: "native-node-unavailable" });
                // This cursor-shaped input is not persisted as a provider turn. The SDK receives the exact transcript parent.
                target = {
                  type: "provider_turn",
                  checkpointId: CheckpointId.make(`throughline-message:${input.messageId}`),
                  appRunOrdinal: selection.targetOrdinal,
                  providerTurn: {
                    id: ProviderTurnId.make(`throughline-rewind:${input.messageId}`),
                    providerThreadId: providerThread.id,
                    nodeId,
                    runAttemptId: null,
                    nativeTurnRef: {
                      driver: providerThread.driver,
                      nativeId: resumeAt,
                      strength: "strong",
                    },
                    ordinal: Math.max(1, selection.targetOrdinal),
                    status: "completed",
                    startedAt: null,
                    completedAt: null,
                  },
                };
              } else if (selection.targetOrdinal === 0) {
                target = {
                  type: "thread_start",
                  checkpointId: CheckpointId.make(`throughline-message:${input.messageId}`),
                  appRunOrdinal: 0,
                };
              } else {
                const run = records.runs.find((run) => run.ordinal === selection.targetOrdinal);
                const attempt = records.attempts.find(
                  (attempt) => attempt.id === run?.activeAttemptId,
                );
                const turn = latestProviderTurnForAttempt(records.providerTurns, attempt?.id);
                if (turn === undefined || turn.providerThreadId !== providerThread.id)
                  return yield* new ExactMessageRewindError({
                    reason: "provider-turn-unavailable",
                  });
                target = {
                  type: "provider_turn",
                  checkpointId: CheckpointId.make(`throughline-message:${input.messageId}`),
                  appRunOrdinal: selection.targetOrdinal,
                  providerTurn: turn,
                };
              }
              const runtimePolicy = yield* policy.resolve({
                thread: records.thread,
                modelSelection: records.thread.modelSelection,
              });
              const previousSession = records.providerSessions.find(
                (row) => row.id === providerThread.providerSessionId,
              );
              const session = yield* sessions.open({
                threadId: input.threadId,
                providerSessionId: providerThread.providerSessionId,
                modelSelection: records.thread.modelSelection,
                runtimePolicy,
                ...(previousSession === undefined ? {} : { resumeFromSession: previousSession }),
                initialNativeThreadId: nativeSessionId,
              });
              const previousCuts =
                resumeAt === undefined
                  ? []
                  : yield* sql<PendingCut>`SELECT * FROM throughline_rewind_cut WHERE thread_id=${input.threadId}`;
              const sourceTipOrdinal = Math.max(0, ...records.runs.map((run) => run.ordinal));
              const sourceTipSequence = yield* eventStore.latestSequence({
                threadId: input.threadId,
              });
              if (resumeAt !== undefined)
                yield* sql`INSERT INTO throughline_rewind_cut (thread_id, provider_thread_id, native_session_id, resume_at, target_message_id, target_run_ordinal, source_tip_run_ordinal, source_tip_sequence, committed_at) VALUES (${input.threadId}, ${providerThread.id}, ${nativeSessionId}, ${resumeAt}, ${input.messageId}, ${selection.targetOrdinal}, ${sourceTipOrdinal}, ${sourceTipSequence}, NULL)
      ON CONFLICT(thread_id) DO UPDATE SET provider_thread_id=excluded.provider_thread_id, native_session_id=excluded.native_session_id, resume_at=excluded.resume_at, target_message_id=excluded.target_message_id, target_run_ordinal=excluded.target_run_ordinal, source_tip_run_ordinal=excluded.source_tip_run_ordinal, source_tip_sequence=excluded.source_tip_sequence, recovery_state='pending', refusal_reason=NULL, committed_at=NULL, created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
              const snapshot = yield* session
                .rollbackThread({
                  providerThread,
                  target,
                  providerThreadTurns: records.providerTurns.filter(
                    (turn) => turn.providerThreadId === providerThread.id,
                  ),
                })
                .pipe(
                  Effect.catch((error) =>
                    Effect.gen(function* () {
                      // A refused adapter call must not become a successful cut after restart.
                      if (resumeAt !== undefined) {
                        const previous = previousCuts[0];
                        if (previous === undefined)
                          yield* sql`DELETE FROM throughline_rewind_cut WHERE thread_id=${input.threadId}`;
                        else
                          yield* sql`UPDATE throughline_rewind_cut SET provider_thread_id=${previous.provider_thread_id}, native_session_id=${previous.native_session_id}, resume_at=${previous.resume_at}, target_message_id=${previous.target_message_id}, target_run_ordinal=${previous.target_run_ordinal}, source_tip_run_ordinal=${previous.source_tip_run_ordinal}, source_tip_sequence=${previous.source_tip_sequence}, recovery_state=${previous.recovery_state}, refusal_reason=${previous.refusal_reason}, created_at=${previous.created_at}, committed_at=${previous.committed_at} WHERE thread_id=${input.threadId}`;
                      }
                      return yield* Effect.fail(error);
                    }),
                  ),
                );
              if (
                resumeAt !== undefined &&
                snapshot.providerThread.nativeThreadRef?.nativeId !== nativeSessionId
              )
                return yield* new ExactMessageRewindError({ reason: "native-session-changed" });
              const now = yield* DateTime.now;
              const events: Array<OrchestrationV2DomainEvent> = [];
              const updated: OrchestrationV2ProviderThread = {
                ...snapshot.providerThread,
                lastRunOrdinal: selection.targetOrdinal === 0 ? null : selection.targetOrdinal,
                updatedAt: now,
              };
              events.push(
                yield* makeEvent({
                  type: "provider-thread.updated",
                  threadId: input.threadId,
                  driver: providerThread.driver,
                  providerInstanceId: providerThread.providerInstanceId,
                  occurredAt: now,
                  payload: updated,
                }),
              );
              for (const selected of selection.runsToRollback) {
                const run = records.runs.find((run) => run.id === selected.id)!;
                // Keep rows/files for history, but never leave a ready file
                // checkpoint live on a discarded run. Same upstream event as
                // CheckpointRollbackService; transaction precedes run trim.
                for (const checkpoint of records.checkpoints.filter(
                  (row) => row.runId === run.id && row.status === "ready",
                )) {
                  events.push(
                    yield* makeEvent({
                      type: "checkpoint.captured",
                      threadId: input.threadId,
                      runId: run.id,
                      nodeId: checkpoint.nodeId,
                      driver: providerThread.driver,
                      providerInstanceId: run.providerInstanceId,
                      occurredAt: now,
                      payload: { ...checkpoint, status: "stale" },
                    }),
                  );
                }
                events.push(
                  yield* makeEvent({
                    type: "run.updated",
                    threadId: input.threadId,
                    runId: run.id,
                    providerInstanceId: run.providerInstanceId,
                    occurredAt: now,
                    payload: { ...run, status: "rolled_back", completedAt: now },
                  }),
                );
                const root = records.nodes.find((node) => node.id === run.rootNodeId);
                if (root !== undefined)
                  events.push(
                    yield* makeEvent({
                      type: "node.updated",
                      threadId: input.threadId,
                      runId: run.id,
                      nodeId: root.id,
                      providerInstanceId: run.providerInstanceId,
                      occurredAt: now,
                      payload: { ...root, status: "rolled_back", completedAt: now },
                    }),
                  );
              }
              const committed = yield* sink.write({ events });
              const last = committed.at(-1);
              if (last === undefined)
                return yield* new ExactMessageRewindError({ reason: "rewind-not-recorded" });
              return {
                threadId: input.threadId,
                messageId: input.messageId,
                sequence: last.sequence,
              };
            }),
          )
          .pipe(
            Effect.mapError((cause) => {
              if (Schema.is(ExactMessageRewindError)(cause)) return cause;
              const protocol = Schema.is(ProviderAdapter.ProviderAdapterProtocolError)(cause)
                ? cause
                : Schema.is(ProviderAdapter.ProviderAdapterRollbackThreadError)(cause) &&
                    Schema.is(ProviderAdapter.ProviderAdapterProtocolError)(cause.cause)
                  ? cause.cause
                  : undefined;
              return new ExactMessageRewindError({ reason: protocol?.detail ?? "rewind-failed" });
            }),
          );

      return ExactMessageRewindV2.of({
        execute,
        recoverPendingCuts,
        recoveryInProgress: (threadId) =>
          Effect.sync(() => !startupRecoveryFinished && !recoveredThreads.has(threadId)),
      });
    }),
  );

export const layer = makeLayer();
