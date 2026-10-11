// Native Node APIs bridge the existing task transport and its file/stream contracts.
// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Migrator from "effect/sql/Migrator";
import * as Logger from "effect/Logger";
import * as SqlClient from "effect/sql/SqlClient";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { migrationManifest, runMigrations } from "../../persistence/Migrations.ts";
import Identity from "../../persistence/Migrations/061_ThroughLineIdentityPersistence.ts";
import Sender from "../../persistence/Migrations/062_ThroughLineMessageSender.ts";
import { backfillLegacyImportSenders } from "../identity/legacyImportSenderBackfill.ts";

const layer = NodeSqliteClient.layer({ filename: ":memory:" });
const runWithoutDivergence = Effect.gen(function* () {
  let divergence = false;
  const logger = Logger.make(({ message }) => {
    if (String(message).includes("Database migration history diverges")) divergence = true;
  });
  const result = yield* runMigrations().pipe(Effect.provide(Logger.layer([logger])));
  assert.isFalse(divergence, "the migration runner must not report divergent history");
  return result;
});
const seed060 = Effect.gen(function* () {
  yield* runMigrations({ toMigrationInclusive: 54 });
  yield* Migrator.make({})({
    loader: Migrator.fromRecord({
      "55_ThroughLineIdentityPersistence": Identity,
      "56_ThroughLineMessageSender": Sender,
    }),
  });
});
const counts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const identity = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM identity_alias`;
  const messages = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM projection_thread_messages`;
  const senders = yield* sql<{
    n: number;
  }>`SELECT COUNT(*) AS n FROM projection_thread_messages WHERE sender_public_id IS NOT NULL`;
  const aliases = yield* sql`SELECT * FROM identity_alias ORDER BY native_kind,native_id`;
  const stamps =
    yield* sql`SELECT message_id,sender_public_id,sender_generation FROM projection_thread_messages WHERE sender_public_id IS NOT NULL ORDER BY message_id`;
  const digest = (rows: unknown) => createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  return {
    identity: identity[0]!.n,
    messages: messages[0]!.n,
    senders: senders[0]!.n,
    aliasesSha256: digest(aliases),
    stampsSha256: digest(stamps),
  };
});
// Hash only the existing non-credential legacy data columns. Adding V2 columns
// must not be mistaken for data loss; removing/changing old data must fail.
const preservedLegacyData = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = [
    "projection_projects",
    "projection_threads",
    "projection_thread_messages",
    "provider_session_runtime",
    "identity_alias",
  ] as const;
  const columnMap: Record<string, string[]> = {};
  for (const table of tables) {
    const columns = yield* sql.unsafe<{ name: string }>(`PRAGMA table_info("${table}")`);
    if (columns.length > 0) columnMap[table] = columns.map((column) => column.name);
  }
  const measure = Effect.gen(function* () {
    const result: Record<string, { rows: number; sha256: string }> = {};
    for (const [table, columns] of Object.entries(columnMap)) {
      const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
      const rows = yield* sql.unsafe(`SELECT ${columns.map(quote).join(",")} FROM ${quote(table)}`);
      const encoded = rows.map((row) => JSON.stringify(row)).sort();
      result[table] = {
        rows: rows.length,
        sha256: createHash("sha256").update(JSON.stringify(encoded)).digest("hex"),
      };
    }
    return result;
  });
  const before = yield* measure;
  assert.isAbove(
    Object.keys(before).length,
    0,
    "legacy preservation measurement must not be empty",
  );
  return { before, measure };
});
const assertMigrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const before = yield* counts;
  const legacy = yield* preservedLegacyData;
  const executed = yield* runWithoutDivergence;
  assert.deepStrictEqual(
    executed.map(([id]) => id),
    [55, 56, 57, 58, 59, 60, 61, 62, 63],
  );
  const history = yield* sql<{
    migration_id: number;
    name: string;
  }>`SELECT migration_id,name FROM effect_sql_migrations ORDER BY migration_id`;
  assert.deepStrictEqual(
    history.map((row) => [row.migration_id, row.name]),
    migrationManifest.map(([id, name]) => [id, name]),
  );
  assert.deepStrictEqual(yield* counts, before);
  assert.deepStrictEqual(
    yield* legacy.measure,
    legacy.before,
    "legacy project/thread/message/native-resume/identity data must remain byte-equivalent",
  );
  const tables = yield* sql<{
    name: string;
  }>`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'orchestration_v2_%'`;
  const schema = fs.readFileSync(
    new URL("../../persistence/Migrations/055_OrchestrationV2.ts", import.meta.url),
    "utf8",
  );
  const expectedTables = [...schema.matchAll(/CREATE TABLE (orchestration_v2_\w+)/g)].map(
    (match) => match[1]!,
  );
  assert.isAbove(expectedTables.length, 0, "schema-table proof must not be vacuous");
  for (const name of expectedTables)
    assert.isTrue(
      tables.some((row) => row.name === name),
      `missing V2 table: ${name}`,
    );
  assert.deepStrictEqual(yield* runWithoutDivergence, []);
});

describe("ThroughLine 0.0.60 migration", () => {
  it.effect(
    "a synthetic 0.0.60 ledger reaches 1..63 with no data loss and a no-op second run",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seed060;
        yield* sql`INSERT INTO identity_alias VALUES ('public','claude','native','generation','2026-10-10')`;
        yield* sql`INSERT INTO projection_thread_messages
        (message_id,thread_id,role,text,is_streaming,created_at,updated_at,sender_public_id,sender_generation)
        VALUES ('old','thread','user','retained',0,'2026-10-10','2026-10-10','public','generation')`;
        yield* assertMigrated;
        yield* sql`INSERT INTO orchestration_v2_projection_messages
        (message_id,thread_id,role,streaming,created_at,updated_at,payload_json)
        VALUES ('new','thread','user',0,'2026-10-10','2026-10-10','{"text":"retained"}')`;
        assert.deepStrictEqual(yield* backfillLegacyImportSenders(), { stamped: 1, unmatched: 0 });
        assert.deepStrictEqual(yield* backfillLegacyImportSenders(), { stamped: 1, unmatched: 0 });
        assert.deepStrictEqual(yield* sql`SELECT * FROM throughline_message_sender`, [
          { message_id: "new", sender_public_id: "public", sender_generation: "generation" },
        ]);
      }).pipe(Effect.provide(layer)),
  );
  it.effect("a fresh database runs 1..63 in order", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        (yield* runMigrations()).map(([id]) => id),
        migrationManifest.map(([id]) => id),
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(layer)),
  );
  it.effect("an unknown row at or above 55 refuses before changing the ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed060;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id,name) VALUES (64,'UnknownBuild')`;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.strictEqual(
        (yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id=55`)[0]!.name,
        "ThroughLineIdentityPersistence",
      );
    }).pipe(Effect.provide(layer)),
  );
  it.effect.each([55, 56, 57, 58, 59, 60, 61, 62, 63])(
    "restart after migration %s preserves data and finishes exactly once",
    (stop) =>
      Effect.gen(function* () {
        yield* seed060;
        const before = yield* counts;
        yield* runMigrations({ toMigrationInclusive: stop });
        assert.deepStrictEqual(
          (yield* runMigrations()).map(([id]) => id),
          migrationManifest.filter(([id]) => id > stop).map(([id]) => id),
        );
        assert.deepStrictEqual(yield* counts, before);
        assert.deepStrictEqual(yield* runMigrations(), []);
      }).pipe(Effect.provide(layer)),
  );
});

const suppliedCopy = process.env.THROUGHLINE_REAL_STATE_DB;
describe.skipIf(!suppliedCopy)("real 0.0.60 database COPY (never the live database)", () => {
  it.effect("a real 0.0.60 database reaches 1..63 with no data loss and a no-op second run", () =>
    Effect.gen(function* () {
      const source = fs.realpathSync(suppliedCopy!);
      assert.isFalse(
        fs.existsSync(source + "-wal"),
        "supply a consolidated non-builder snapshot, not a database with unmerged WAL",
      );
      const sourceHash = createHash("sha256").update(fs.readFileSync(source)).digest("hex");
      for (const live of [
        path.join(os.homedir(), ".t3/userdata/state.sqlite"),
        "/srv/agents-runtime-state/throughline/userdata/state.sqlite",
      ]) {
        if (!fs.existsSync(live)) continue;
        const a = fs.statSync(source),
          b = fs.statSync(live);
        assert.isFalse(
          a.dev === b.dev && a.ino === b.ino,
          "THROUGHLINE_REAL_STATE_DB must be a non-builder COPY, not a live path, symlink or hardlink.",
        );
      }
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "throughline-migration-copy-"));
      const testCopy = path.join(directory, "state.sqlite");
      fs.copyFileSync(source, testCopy);
      // copyFile preserves the supplied snapshot's read-only mode. Only the
      // disposable copy becomes writable; input custody/hash stay unchanged.
      fs.chmodSync(testCopy, 0o600);
      try {
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const before = yield* sql<{
            migration_id: number;
            name: string;
          }>`SELECT migration_id,name FROM effect_sql_migrations WHERE migration_id>=55 ORDER BY migration_id`;
          assert.deepStrictEqual(before, [
            { migration_id: 55, name: "ThroughLineIdentityPersistence" },
            { migration_id: 56, name: "ThroughLineMessageSender" },
          ]);
          yield* assertMigrated;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: testCopy })));
      } finally {
        // Only this test's captured, disposable files. Never any supplied or live path.
        for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(testCopy + suffix, { force: true });
        fs.rmdirSync(directory);
      }
      assert.strictEqual(
        createHash("sha256").update(fs.readFileSync(source)).digest("hex"),
        sourceHash,
        "supplied snapshot must remain unchanged",
      );
    }),
  );
});
