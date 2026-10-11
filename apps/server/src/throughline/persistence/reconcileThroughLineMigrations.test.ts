import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import { reconcileThroughLineMigrations } from "./reconcileThroughLineMigrations.ts";

const layer = NodeSqliteClient.layer({ filename: ":memory:" });
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
  yield* sql`INSERT INTO effect_sql_migrations VALUES (54, 'ProjectionThreadsAutoSettleDisabledAt'), (55, 'ThroughLineIdentityPersistence'), (56, 'ThroughLineMessageSender')`;
  yield* sql`CREATE TABLE identity_alias (public_agent_id TEXT)`;
  yield* sql`INSERT INTO identity_alias VALUES ('kept')`;
});

describe("ThroughLine migration ledger pre-step", () => {
  it.effect("removes only the two exact old fork ledger rows and preserves schema and data", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      assert.deepStrictEqual(yield* reconcileThroughLineMigrations(), [
        [55, "ThroughLineIdentityPersistence"],
        [56, "ThroughLineMessageSender"],
      ]);
      assert.deepStrictEqual(yield* sql`SELECT * FROM identity_alias`, [
        { public_agent_id: "kept" },
      ]);
      assert.deepStrictEqual(yield* sql`SELECT migration_id FROM effect_sql_migrations`, [
        { migration_id: 54 },
      ]);
      assert.deepStrictEqual(yield* reconcileThroughLineMigrations(), []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("unknown later history refuses before deleting either fork row", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      yield* sql`INSERT INTO effect_sql_migrations VALUES (64, 'UnknownBuild')`;
      const failure = yield* Effect.flip(reconcileThroughLineMigrations());
      assert.strictEqual(failure._tag, "MigrationError");
      if (failure._tag === "MigrationError") assert.strictEqual(failure.kind, "BadState");
      assert.include(failure.message, "64:UnknownBuild");
      assert.strictEqual((yield* sql`SELECT * FROM effect_sql_migrations`).length, 4);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "refuses mixed old-fork and later upstream history rather than silently skipping 55",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seed;
        yield* sql`INSERT INTO effect_sql_migrations VALUES (57, 'ScheduledTaskWebhooks')`;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(reconcileThroughLineMigrations())));
        assert.strictEqual((yield* sql`SELECT * FROM effect_sql_migrations`).length, 4);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("leaves known upstream and renumbered fork rows untouched", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
      yield* sql`INSERT INTO effect_sql_migrations VALUES (55, 'OrchestrationV2'), (56, 'RemoveRedundantProjectionIndexes'), (61, 'PullRequestReviewGuides'), (62, 'ThroughLineIdentityPersistence'), (63, 'ThroughLineMessageSender')`;
      assert.deepStrictEqual(yield* reconcileThroughLineMigrations(), []);
      assert.strictEqual((yield* sql`SELECT * FROM effect_sql_migrations`).length, 5);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a fresh database has nothing to reconcile", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* reconcileThroughLineMigrations(), []);
    }).pipe(Effect.provide(layer)),
  );
});
