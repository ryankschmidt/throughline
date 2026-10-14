import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as LegacyImporter from "../../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as SenderBackfill from "./legacyImportSenderBackfill.ts";

it.effect(
  "lazy legacy transcript import stamps the resulting V2 message without replaying an action",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`INSERT INTO projection_thread_messages
      (message_id,thread_id,role,text,is_streaming,created_at,updated_at,sender_public_id,sender_generation)
      VALUES ('old','thread','user','text',0,'2026-10-10','2026-10-10','public','generation')`;
      let imports = 0;
      const importer = LegacyImporter.LegacyV1ThreadImporter.of({
        pendingThreadCount: Effect.succeed(1),
        reconcileShells: Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
        importPendingTranscripts: Effect.succeed({
          importedThreadCount: 0,
          importedMessageCount: 0,
        }),
        ensureTranscript: () =>
          Effect.gen(function* () {
            imports++;
            yield* sql`INSERT OR IGNORE INTO orchestration_v2_projection_messages
          (message_id,thread_id,role,streaming,created_at,updated_at,payload_json)
          VALUES ('new','thread','user',0,'2026-10-10','2026-10-10','{"text":"text"}')`;
            return { importedThreadCount: 1, importedMessageCount: 1 };
          }).pipe(
            Effect.mapError(
              (cause) =>
                new LegacyImporter.LegacyV1ThreadImportError({
                  operation: "test import",
                  threadId: ThreadId.make("thread"),
                  cause,
                }),
            ),
          ),
      });
      const test = Effect.gen(function* () {
        const decorated = yield* LegacyImporter.LegacyV1ThreadImporter;
        yield* decorated.ensureTranscript(ThreadId.make("thread"));
        assert.deepStrictEqual(yield* sql`SELECT * FROM throughline_message_sender`, [
          { message_id: "new", sender_public_id: "public", sender_generation: "generation" },
        ]);
        assert.strictEqual(imports, 1);
        assert.strictEqual((yield* sql`SELECT * FROM orchestration_v2_projection_runs`).length, 0);
        assert.deepStrictEqual(yield* SenderBackfill.backfillLegacyImportSenders(), {
          stamped: 1,
          unmatched: 0,
        });
      });
      yield* test.pipe(
        Effect.provide(
          SenderBackfill.layer.pipe(
            Layer.provide(Layer.succeed(LegacyImporter.LegacyV1ThreadImporter, importer)),
            Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
          ),
        ),
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "legacy sender carry prefers the same message id, else the lowest matching id, on SQLite 3.51",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      // Two stamped 0.0.60 messages; one has a same-id V2 copy beside a lower-id duplicate.
      yield* sql`INSERT INTO projection_thread_messages
      (message_id,thread_id,role,text,is_streaming,created_at,updated_at,sender_public_id,sender_generation)
      VALUES ('m1','thread','user','same',0,'2026-10-10','2026-10-10','public','generation'),
        ('m2','thread','user','other',0,'2026-10-11','2026-10-11','public','generation')`;
      yield* sql`INSERT INTO orchestration_v2_projection_messages
      (message_id,thread_id,role,streaming,created_at,updated_at,payload_json)
      VALUES ('a0','thread','user',0,'2026-10-10','2026-10-10','{"text":"same"}'),
        ('m1','thread','user',0,'2026-10-10','2026-10-10','{"text":"same"}'),
        ('z9','thread','user',0,'2026-10-11','2026-10-11','{"text":"other"}'),
        ('b1','thread','user',0,'2026-10-11','2026-10-11','{"text":"other"}')`;
      assert.deepStrictEqual(yield* SenderBackfill.backfillLegacyImportSenders(), {
        stamped: 2,
        unmatched: 0,
      });
      assert.deepStrictEqual(
        yield* sql`SELECT message_id FROM throughline_message_sender ORDER BY message_id`,
        [{ message_id: "b1" }, { message_id: "m1" }],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
