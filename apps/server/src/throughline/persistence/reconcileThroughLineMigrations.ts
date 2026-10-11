import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

const known = new Map([
  [55, "OrchestrationV2"],
  [56, "RemoveRedundantProjectionIndexes"],
  [57, "ScheduledTaskWebhooks"],
  [58, "WebhookRelayDeliveries"],
  [59, "McpAppModelContext"],
  [60, "ThreadSnapshotWindowIndexes"],
  [61, "PullRequestReviewGuides"],
  [62, "ThroughLineIdentityPersistence"],
  [63, "ThroughLineMessageSender"],
  [64, "ThroughLineRewindCutAndObservation"],
]);
const legacy = new Map([
  [55, "ThroughLineIdentityPersistence"],
  [56, "ThroughLineMessageSender"],
]);

/** Reconcile ledger identity only. Schema and user rows never change in this pre-step. */
export const reconcileThroughLineMigrations = Effect.fn("reconcileThroughLineMigrations")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const tables =
          yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'`;
        if (tables.length === 0) return [];
        const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 55 ORDER BY migration_id
    `;
        const old = rows.filter((row) => legacy.get(row.migration_id) === row.name);
        const unknown = rows.find(
          (row) =>
            known.get(row.migration_id) !== row.name && legacy.get(row.migration_id) !== row.name,
        );
        // A later known row alongside old fork rows would keep MAX(id) above 54 and skip
        // upstream's V2 creation. Such a mixed build must refuse, not appear reconciled.
        const mixed = old.length > 0 ? rows.find((row) => !old.includes(row)) : undefined;
        const bad = unknown ?? mixed;
        if (bad)
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: `Cannot reconcile ThroughLine migration history: ${bad.migration_id}:${bad.name}${unknown ? " is unknown to this build" : " is mixed with legacy fork rows"}. No rows were changed.`,
          });
        for (const row of old) {
          yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = ${row.migration_id} AND name = ${row.name}`;
        }
        return old.map((row) => [row.migration_id, row.name] as const);
      }),
    );
  },
);
