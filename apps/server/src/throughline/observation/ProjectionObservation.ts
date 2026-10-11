import { SETTINGS_ITEM_PREFIX, stampSettingsRecord } from "../settings-intent/SettingsRecord.ts";
import { stampHeadroomWait, validateHeadroomTransition } from "../headroom/HeadroomWaitRecord.ts";
import {
  RunId,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { CurrentAuthenticatedSender, stampV2MessageSender } from "../identity/sender-stamp.ts";
import { backfillLegacyImportSenders } from "../identity/legacyImportSenderBackfill.ts";
const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
const reportedModel = (value: unknown): string | undefined => {
  const model = object(value)?.model;
  return typeof model === "string" && model.trim().length > 0 ? model : undefined;
};
export interface ObservationOptions {
  readonly transcriptPath?: (
    nativeId: string,
    providerInstanceId: string,
  ) => Promise<string | undefined>;
}

export class CaptureAfterCutRefusal extends Schema.TaggedError<CaptureAfterCutRefusal>()(
  "CaptureAfterCutRefusal",
  { runId: RunId, eventType: Schema.String },
) {
  override get message() {
    return "Checkpoint capture belongs to a run already removed by a conversation cut.";
  }
}
/** Called before base.apply on the transaction client; stale capture cannot resurrect a cut run. */
export const guardCaptureAfterCut = (event: OrchestrationV2DomainEvent) =>
  Effect.gen(function* () {
    if (event.type === "checkpoint.captured" && event.payload.status === "stale") return;
    const runId =
      event.type === "checkpoint.captured"
        ? event.payload.runId
        : event.type === "run.updated" && event.payload.checkpointId !== null
          ? event.payload.id
          : undefined;
    if (runId === undefined || runId === null) return;
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      status: string;
    }>`SELECT status FROM orchestration_v2_projection_runs WHERE run_id=${runId}`;
    if (rows[0]?.status === "rolled_back")
      return yield* new CaptureAfterCutRefusal({ runId, eventType: event.type });
  });

/** Projection metadata, not a second event log. Requested models never become observed models. */
export const observeEvents = (
  events: readonly Pick<OrchestrationV2StoredEvent, "event">[],
  _options: ObservationOptions = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sender = yield* CurrentAuthenticatedSender;
    const legacyThreads = new Set<string>();
    for (const stored of events) {
      const event = stored.event;
      if (event.type === "run.updated") yield* stampHeadroomWait(event);
      if (
        event.type === "turn-item.updated" &&
        event.payload.type === "system_notice" &&
        event.payload.id.startsWith(SETTINGS_ITEM_PREFIX)
      )
        yield* stampSettingsRecord(event.payload.id);
      if (event.type === "provider-thread.updated") {
        const thread = event.payload;
        if (thread.appThreadId === null) continue;
        if (thread.ownerNodeId !== null) {
          const owner = yield* sql<{
            parent_node_id: string | null;
          }>`SELECT parent_node_id FROM orchestration_v2_projection_nodes WHERE node_id=${thread.ownerNodeId}`;
          if (owner.length !== 1 || owner[0]!.parent_node_id !== null) continue;
        }
        const nativeId = thread.nativeThreadRef?.nativeId ?? null;
        yield* sql`INSERT INTO throughline_thread_identity
          (thread_id,provider_thread_id,provider_session_id,native_session_id,native_transcript_path)
          VALUES (${thread.appThreadId},${thread.id},${thread.providerSessionId},${nativeId},${null})
          ON CONFLICT(thread_id) DO UPDATE SET provider_thread_id=excluded.provider_thread_id,
            provider_session_id=excluded.provider_session_id, native_session_id=excluded.native_session_id,
            native_transcript_path=CASE WHEN throughline_thread_identity.provider_thread_id=excluded.provider_thread_id THEN throughline_thread_identity.native_transcript_path ELSE NULL END`;
      }
      if (event.type === "run.created" || event.type === "run.updated") {
        const run = event.payload;
        yield* sql`INSERT INTO throughline_run_observation (run_id,thread_id,requested_model,scope)
          VALUES (${run.id},${run.threadId},${run.modelSelection.model},'main-run')
          ON CONFLICT(run_id) DO UPDATE SET requested_model=excluded.requested_model`;
      }
      if (event.type === "message.updated") {
        const message = event.payload;
        if (String(event.id).startsWith("migration:v1:")) legacyThreads.add(message.threadId);
        if (message.role === "user" && sender !== undefined)
          yield* stampV2MessageSender(message.id, sender);
        if (message.role === "assistant" && message.streaming === false) {
          yield* sql`UPDATE throughline_rewind_cut SET committed_at=${DateTime.formatIso(event.occurredAt)}
            WHERE thread_id=${message.threadId} AND committed_at IS NULL
              AND recovery_state <> 'refused'
              AND EXISTS (SELECT 1 FROM orchestration_v2_projection_runs run
                WHERE run.run_id=${message.runId} AND run.ordinal > throughline_rewind_cut.source_tip_run_ordinal)
              AND EXISTS (SELECT 1 FROM orchestration_events emitted
                WHERE emitted.event_id=${event.id} AND emitted.sequence > throughline_rewind_cut.source_tip_sequence)`;
        }
        const model =
          message.role === "assistant" && message.runId !== null
            ? reportedModel(message)
            : undefined;
        if (model && message.runId)
          yield* sql`UPDATE throughline_run_observation
          SET answering_model=${model},source='provider-event'
          WHERE run_id=${message.runId} AND answering_model IS NULL
            AND (${message.nodeId} IS NULL OR EXISTS (SELECT 1 FROM orchestration_v2_projection_nodes
              WHERE node_id=${message.nodeId} AND parent_node_id IS NULL))`;
      }
      if (event.type === "provider-turn.updated") {
        const turn = event.payload;
        const model = reportedModel(turn);
        if (model && turn.runAttemptId)
          yield* sql`UPDATE throughline_run_observation
          SET answering_model=${model},source='provider-event'
          WHERE run_id IN (SELECT attempt.run_id FROM orchestration_v2_projection_run_attempts attempt
            JOIN orchestration_v2_projection_nodes node ON node.node_id=attempt.root_node_id
            WHERE attempt.attempt_id=${turn.runAttemptId} AND node.parent_node_id IS NULL)
            AND answering_model IS NULL`;
      }
    }
    for (const threadId of legacyThreads) yield* backfillLegacyImportSenders(threadId);
  });

/** SQL-only apply: caller's transaction client is resolved per invocation. */
export const makeObservedProjectionStore = (
  base: ProjectionStore.ProjectionStoreV2Shape,
): ProjectionStore.ProjectionStoreV2Shape => ({
  ...base,
  apply: (event) =>
    Effect.gen(function* () {
      const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
      if (Option.isNone(sql))
        return yield* new ProjectionStore.ProjectionStoreApplyEventError({
          eventType: event.type,
          cause: "Transaction SqlClient unavailable",
        });
      yield* guardCaptureAfterCut(event).pipe(
        Effect.provideService(SqlClient.SqlClient, sql.value),
      );
      yield* validateHeadroomTransition(event).pipe(
        Effect.provideService(SqlClient.SqlClient, sql.value),
      );
      yield* base.apply(event);
      yield* observeEvents([{ event }]).pipe(Effect.provideService(SqlClient.SqlClient, sql.value));
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectionStore.ProjectionStoreApplyEventError({ eventType: event.type, cause }),
      ),
    ),
});
export const layer = Layer.effect(
  ProjectionStore.ProjectionStoreV2,
  Effect.map(ProjectionStore.ProjectionStoreV2, makeObservedProjectionStore),
);
