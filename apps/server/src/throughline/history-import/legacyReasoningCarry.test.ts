import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as LegacyImporter from "../../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as RuntimeLayer from "../../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as LegacyReasoningCarry from "./legacyReasoningCarry.ts";

const layer = LegacyReasoningCarry.layer.pipe(
  Layer.provide(LegacyImporter.layer),
  Layer.provideMerge(RuntimeLayer.layerEventSink),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.effect(
  "migrated thinking traces become reasoning items in their original order, once, replay-safe",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyImporter.LegacyV1ThreadImporter;
      const threadId = ThreadId.make("legacy-reasoning-thread");
      const projectId = ProjectId.make("legacy-reasoning-project");
      yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at, deleted_at)
        VALUES (${projectId}, 'Project', '/tmp/legacy-reasoning-project', '{"instanceId":"claudeAgent","model":"claude-opus-5-5"}', '[]',
          '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', NULL)`;
      yield* sql`INSERT INTO projection_threads
        (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, branch, worktree_path,
          latest_turn_id, created_at, updated_at, archived_at, settled_override, settled_at, deleted_at)
        VALUES (${threadId}, ${projectId}, 'Thinking thread', '{"instanceId":"claudeAgent","model":"claude-opus-5-5"}',
          'full-access', 'default', NULL, NULL, NULL, '2026-09-01T00:00:00.000Z', '2026-09-01T00:05:00.000Z',
          NULL, NULL, NULL, NULL)`;
      // A 0.0.60 transcript: each answer is preceded by the provider's thinking trace.
      const v1 = [
        ["m1", "user", "First question"],
        ["m2", "reasoning", "Thinking about the first question"],
        ["m3", "assistant", "First answer"],
        ["m4", "user", "Second question"],
        ["m5", "reasoning", "Thinking about the second question"],
        ["m6", "assistant", "Second answer"],
      ] as const;
      for (const [index, [id, role, text]] of v1.entries()) {
        const at = `2026-09-01T00:0${index}:00.000Z`;
        yield* sql`INSERT INTO projection_thread_messages
          (message_id, thread_id, turn_id, role, text, attachments_json, is_streaming, created_at, updated_at)
          VALUES (${id}, ${threadId}, NULL, ${role}, ${text}, '[]', 0, ${at}, ${at})`;
      }

      yield* importer.reconcileShells;
      yield* importer.ensureTranscript(threadId);

      const items = yield* sql<{
        readonly type: string;
        readonly ordinal: number;
        readonly text: string;
      }>`
        SELECT type, ordinal, json_extract(payload_json, '$.text') AS text
        FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId} ORDER BY ordinal`;
      assert.deepStrictEqual(
        items.map((item) => [item.ordinal, item.type, item.text]),
        [
          [1, "user_message", "First question"],
          [2, "reasoning", "Thinking about the first question"],
          [3, "assistant_message", "First answer"],
          [4, "user_message", "Second question"],
          [5, "reasoning", "Thinking about the second question"],
          [6, "assistant_message", "Second answer"],
        ],
      );
      const messages = yield* sql<{ readonly n: number }>`
        SELECT count(*) AS n FROM orchestration_v2_projection_messages WHERE thread_id = ${threadId}`;
      assert.strictEqual(messages[0]!.n, 4);
      const positions = yield* sql<{ readonly mismatched: number }>`
        SELECT count(*) AS mismatched FROM orchestration_v2_projection_turn_items item
        JOIN orchestration_v2_turn_item_positions position USING (thread_id, turn_item_id)
        WHERE item.thread_id = ${threadId} AND item.ordinal <> position.ordinal`;
      assert.strictEqual(positions[0]!.mismatched, 0);

      // A second open and a background pass add nothing.
      const events = sql<{ readonly n: number }>`SELECT count(*) AS n FROM orchestration_events`;
      const before = (yield* events)[0]!.n;
      yield* importer.ensureTranscript(threadId);
      yield* importer.importPendingTranscripts;
      assert.strictEqual((yield* events)[0]!.n, before);

      // Projection rebuilds replay positions in log order under the same unique constraint.
      yield* sql`CREATE TEMP TABLE replay_positions (thread_id TEXT NOT NULL, turn_item_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL, PRIMARY KEY (thread_id, turn_item_id), UNIQUE (thread_id, ordinal))`;
      const log = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_events
        WHERE event_type = 'turn-item.updated' AND stream_id = ${threadId} ORDER BY sequence`;
      for (const row of log) {
        const payload = JSON.parse(row.payload_json) as { id: string; ordinal: number };
        yield* sql`INSERT INTO replay_positions (thread_id, turn_item_id, ordinal)
          VALUES (${threadId}, ${payload.id}, ${payload.ordinal})
          ON CONFLICT(thread_id, turn_item_id) DO UPDATE SET ordinal = excluded.ordinal`;
      }
      const replayed = yield* sql<{ readonly ordinal: number }>`
        SELECT ordinal FROM replay_positions ORDER BY ordinal`;
      assert.deepStrictEqual(
        replayed.map((row) => row.ordinal),
        [1, 2, 3, 4, 5, 6],
      );
    }).pipe(Effect.provide(layer)),
);
