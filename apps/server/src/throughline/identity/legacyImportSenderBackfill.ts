import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Layer from "effect/Layer";
import * as LegacyImporter from "../../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import { ThreadId } from "@t3tools/contracts";

/** Carries authenticated legacy metadata only; no messages, turns or actions are replayed. */
export const backfillLegacyImportSenders = Effect.fn("backfillLegacyImportSenders")(function* (
  threadId?: string,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const rows = yield* sql<{
        readonly message_id: string;
        readonly sender_public_id: string;
        readonly sender_generation: string;
        readonly destination_id: string | null;
      }>`
      SELECT old.message_id, old.sender_public_id, old.sender_generation,
        -- Prefer the same message id, else the lowest matching id. SQLite 3.51 refuses an outer
        -- column inside a correlated subquery's ORDER BY, so the preference is two lookups.
        COALESCE(
          (SELECT current.message_id FROM orchestration_v2_projection_messages current
            WHERE current.message_id = old.message_id
              AND current.thread_id = old.thread_id AND current.role = old.role
              AND (current.created_at = old.created_at OR julianday(current.created_at) = julianday(old.created_at))
              AND json_extract(current.payload_json, '$.text') = old.text),
          (SELECT current.message_id FROM orchestration_v2_projection_messages current
            WHERE current.thread_id = old.thread_id AND current.role = old.role
              AND (current.created_at = old.created_at OR julianday(current.created_at) = julianday(old.created_at))
              AND json_extract(current.payload_json, '$.text') = old.text
            ORDER BY current.message_id
            LIMIT 1)
        ) AS destination_id
      FROM projection_thread_messages old
      WHERE old.sender_public_id IS NOT NULL AND old.sender_generation IS NOT NULL
        AND (${threadId ?? null} IS NULL OR old.thread_id = ${threadId ?? null})
      ORDER BY old.thread_id, old.created_at, old.message_id
    `;
      let stamped = 0;
      let unmatched = 0;
      for (const row of rows) {
        if (row.destination_id === null) {
          unmatched++;
          continue;
        }
        // Do not ignore an identity conflict. The immutable trigger must refuse it,
        // rolling back this batch instead of silently replacing authenticated metadata.
        yield* sql`
        INSERT INTO throughline_message_sender (message_id, sender_public_id, sender_generation)
        VALUES (${row.destination_id}, ${row.sender_public_id}, ${row.sender_generation})
        ON CONFLICT(message_id) DO UPDATE SET
          sender_public_id = excluded.sender_public_id,
          sender_generation = excluded.sender_generation
      `;
        stamped++;
      }
      return { stamped, unmatched };
    }),
  );
});

/** Decorates the published importer service; upstream's lazy/background import is unchanged. */
export const layer = Layer.effect(
  LegacyImporter.LegacyV1ThreadImporter,
  Effect.gen(function* () {
    const importer = yield* LegacyImporter.LegacyV1ThreadImporter;
    const sql = yield* SqlClient.SqlClient;
    const carry = (threadId?: string) =>
      backfillLegacyImportSenders(threadId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError(
          (cause) =>
            new LegacyImporter.LegacyV1ThreadImportError({
              operation: "carry authenticated senders for",
              ...(threadId ? { threadId: ThreadId.make(threadId) } : {}),
              cause,
            }),
        ),
      );
    return LegacyImporter.LegacyV1ThreadImporter.of({
      ...importer,
      ensureTranscript: (threadId) =>
        importer.ensureTranscript(threadId).pipe(Effect.tap(() => carry(threadId))),
      importPendingTranscripts: importer.importPendingTranscripts.pipe(
        Effect.tap(() => carry().pipe(Effect.orDie)),
      ),
    });
  }),
);
