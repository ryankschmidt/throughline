import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(projection_thread_messages)`;
  for (const name of ["sender_public_id", "sender_generation"] as const) {
    if (!columns.some((column) => column.name === name)) {
      yield* sql.unsafe(
        `ALTER TABLE projection_thread_messages ADD COLUMN ${name} TEXT CHECK(${name} IS NULL OR length(trim(${name})) > 0)`,
      );
    }
  }
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS throughline_sender_pair_insert
    BEFORE INSERT ON projection_thread_messages
    WHEN (NEW.sender_public_id IS NULL) <> (NEW.sender_generation IS NULL)
    BEGIN SELECT RAISE(ABORT, 'Incomplete sender stamp'); END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS throughline_sender_immutable_update
    BEFORE UPDATE OF sender_public_id, sender_generation ON projection_thread_messages
    WHEN (NEW.sender_public_id IS NULL) <> (NEW.sender_generation IS NULL)
      OR (OLD.sender_public_id IS NOT NULL AND
        (NEW.sender_public_id IS NOT OLD.sender_public_id OR NEW.sender_generation IS NOT OLD.sender_generation))
    BEGIN SELECT RAISE(ABORT, 'Sender generation mismatch'); END
  `;
  // V2 owns its message schema; the fork's authenticated sender lives beside it.
  yield* sql`
    CREATE TABLE IF NOT EXISTS throughline_message_sender (
      message_id TEXT PRIMARY KEY,
      sender_public_id TEXT NOT NULL CHECK(length(trim(sender_public_id)) > 0),
      sender_generation TEXT NOT NULL CHECK(length(trim(sender_generation)) > 0)
    )
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS throughline_v2_sender_immutable_update
    BEFORE UPDATE OF sender_public_id, sender_generation ON throughline_message_sender
    WHEN NEW.sender_public_id IS NOT OLD.sender_public_id
      OR NEW.sender_generation IS NOT OLD.sender_generation
    BEGIN SELECT RAISE(ABORT, 'Sender generation mismatch'); END
  `;
});
