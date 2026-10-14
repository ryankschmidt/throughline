import {
  EventId,
  OrchestrationV2TurnItemJson,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as LegacyImporter from "../../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";

// The stock importer names each imported item after its V1 message; reasoning items use the same scheme.
const PREFIX = "migration:v1";
const EVENT_BATCH_SIZE = 100;
const itemIdOf = (messageId: string) => TurnItemId.make(`${PREFIX}:turn-item:${messageId}`);
const decodeTurnItem = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2TurnItemJson),
);

export class LegacyReasoningCarryError extends Schema.TaggedError<LegacyReasoningCarryError>()(
  "LegacyReasoningCarryError",
  { threadId: ThreadId, reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

interface LegacyRow {
  readonly message_id: string;
  readonly role: string;
  readonly text: string;
  readonly is_streaming: number;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * Carries a migrated thread's V1 reasoning rows into V2 as reasoning turn items, in their original
 * conversation order. The stock importer numbers only user and assistant items, so this moves those
 * items to their full V1 positions first (highest first, so positions never collide, also on replay)
 * and then adds the reasoning items in the gaps. Already-carried items are skipped; it is safe to rerun.
 */
export const carryLegacyReasoning = Effect.fn("carryLegacyReasoning")(function* (
  threadId: ThreadId,
) {
  const sql = yield* SqlClient.SqlClient;
  const eventSink = yield* EventSink.EventSinkV2;
  const refuse = (reason: string) => new LegacyReasoningCarryError({ threadId, reason });
  const rows = yield* sql<LegacyRow>`
    SELECT message_id, role, text, is_streaming, created_at, updated_at
    FROM projection_thread_messages
    WHERE thread_id = ${threadId} AND role IN ('user', 'assistant', 'reasoning')
    ORDER BY created_at ASC, message_id ASC
  `;
  if (!rows.some((row) => row.role === "reasoning")) return 0;
  const desired = new Map(rows.map((row, index) => [itemIdOf(row.message_id), index + 1]));
  const positions = new Map(
    (yield* sql<{ readonly turn_item_id: string; readonly ordinal: number }>`
      SELECT turn_item_id, ordinal FROM orchestration_v2_turn_item_positions WHERE thread_id = ${threadId}
    `).map((row) => [row.turn_item_id, row.ordinal]),
  );
  const projected = new Map(
    (yield* sql<{
      readonly turn_item_id: string;
      readonly ordinal: number;
      readonly payload_json: string;
    }>`
      SELECT turn_item_id, ordinal, payload_json FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${threadId} AND turn_item_id LIKE ${`${PREFIX}:turn-item:%`}
    `).map((row) => [row.turn_item_id, row]),
  );
  for (const row of rows)
    if (row.role !== "reasoning" && !projected.has(itemIdOf(row.message_id)))
      return yield* refuse("the stock transcript import has not finished for this thread");
  for (const [turnItemId, ordinal] of positions)
    if (!desired.has(TurnItemId.make(turnItemId)) && ordinal >= 1 && ordinal <= rows.length)
      return yield* refuse(`a non-migrated item already holds position ${ordinal}`);

  // Existing migrated items whose position changes, highest current position first.
  const moves = rows
    .filter((row) => row.role !== "reasoning" || projected.has(itemIdOf(row.message_id)))
    .map((row) => itemIdOf(row.message_id))
    .filter((id) => projected.get(id)!.ordinal !== desired.get(id))
    .sort((a, b) => (positions.get(b) ?? 0) - (positions.get(a) ?? 0));
  for (const id of moves)
    if ((positions.get(id) ?? 0) > desired.get(id)!)
      return yield* refuse(`item ${id} would move to an earlier position`);
  const added = rows.filter(
    (row) => row.role === "reasoning" && !projected.has(itemIdOf(row.message_id)),
  );
  if (moves.length === 0 && added.length === 0) return 0;

  const events: OrchestrationV2DomainEvent[] = [];
  for (const id of moves) {
    const item: OrchestrationV2TurnItem = yield* decodeTurnItem(projected.get(id)!.payload_json);
    const ordinal = desired.get(id)!;
    yield* sql`
      UPDATE orchestration_v2_turn_item_positions SET ordinal = ${ordinal}
      WHERE thread_id = ${threadId} AND turn_item_id = ${id}
    `;
    events.push({
      id: EventId.make(`${PREFIX}:reasoning-carry:position:${id}:${ordinal}`),
      type: "turn-item.updated",
      threadId,
      occurredAt: item.updatedAt,
      payload: { ...item, ordinal },
    });
  }
  for (const row of added) {
    const id = itemIdOf(row.message_id);
    const ordinal = desired.get(id)!;
    const createdAt = DateTime.makeUnsafe(row.created_at);
    const updatedAt = DateTime.makeUnsafe(row.updated_at);
    yield* sql`
      INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
      VALUES (${threadId}, ${id}, ${ordinal})
      ON CONFLICT(thread_id, turn_item_id) DO UPDATE SET ordinal = excluded.ordinal
    `;
    events.push({
      id: EventId.make(id),
      type: "turn-item.updated",
      threadId,
      occurredAt: updatedAt,
      payload: {
        id,
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: row.is_streaming === 1 ? "interrupted" : "completed",
        title: null,
        startedAt: createdAt,
        completedAt: updatedAt,
        updatedAt,
        type: "reasoning",
        text: row.text,
        streaming: false,
      },
    });
  }
  for (let index = 0; index < events.length; index += EVENT_BATCH_SIZE) {
    yield* eventSink.write({ events: events.slice(index, index + EVENT_BATCH_SIZE) });
    yield* Effect.yieldNow;
  }
  return added.length;
});

/** Decorates the published importer service; the stock import and its ordering stay unchanged. */
export const layer = Layer.effect(
  LegacyImporter.LegacyV1ThreadImporter,
  Effect.gen(function* () {
    const importer = yield* LegacyImporter.LegacyV1ThreadImporter;
    const sql = yield* SqlClient.SqlClient;
    const eventSink = yield* EventSink.EventSinkV2;
    const carried = new Set<ThreadId>();
    const carryError = "Reasoning carry failed; retry on next open.";
    const carry = (threadId: ThreadId) =>
      carryLegacyReasoning(threadId).pipe(
        Effect.tap(() => Effect.sync(() => carried.add(threadId))),
        Effect.tap(
          () =>
            sql`UPDATE orchestration_v2_legacy_imports SET last_error = NULL
              WHERE thread_id = ${threadId} AND last_error = ${carryError}`,
        ),
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(EventSink.EventSinkV2, eventSink),
      );
    const pendingThreads = sql<{ readonly thread_id: string }>`
      SELECT DISTINCT message.thread_id
      FROM projection_thread_messages message
      JOIN orchestration_v2_legacy_imports imported ON imported.thread_id = message.thread_id
      WHERE message.role = 'reasoning' AND imported.transcript_imported_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_turn_items item
          WHERE item.turn_item_id = ${`${PREFIX}:turn-item:`} || message.message_id
        )
    `;
    const carryPending = Effect.gen(function* () {
      for (const row of yield* pendingThreads) {
        const threadId = ThreadId.make(row.thread_id);
        yield* carry(threadId).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Failed to carry legacy v1 reasoning", { threadId, cause }).pipe(
              Effect.andThen(
                sql`
                  UPDATE orchestration_v2_legacy_imports SET last_error = ${carryError}
                  WHERE thread_id = ${threadId}
                `,
              ),
            ),
          ),
        );
      }
    }).pipe(
      Effect.catch((cause) => Effect.logWarning("Failed to list legacy v1 reasoning", { cause })),
    );
    return LegacyImporter.LegacyV1ThreadImporter.of({
      ...importer,
      ensureTranscript: (threadId) =>
        importer.ensureTranscript(threadId).pipe(
          Effect.tap(() =>
            carried.has(threadId)
              ? Effect.void
              : carry(threadId).pipe(
                  Effect.mapError(
                    (cause) =>
                      new LegacyImporter.LegacyV1ThreadImportError({
                        operation: "carry reasoning for",
                        threadId,
                        cause,
                      }),
                  ),
                ),
          ),
        ),
      importPendingTranscripts: importer.importPendingTranscripts.pipe(
        Effect.tap(() => carryPending),
      ),
    });
  }),
);
