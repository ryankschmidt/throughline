import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import {
  stampV2MessageSender,
  readV2MessageSender,
  captureSenderClaims,
  assertSenderClaims,
} from "./sender-stamp.ts";

const sender = {
  publicAgentId: "public",
  generation: "generation",
  nativeKind: "app-session",
  nativeId: "native",
} as const;
it.effect("V2 sender stamps are idempotent, immutable and bound to an existing message", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    assert.isTrue(Exit.isFailure(yield* Effect.exit(stampV2MessageSender("absent", sender))));
    assert.strictEqual(
      (yield* sql`SELECT * FROM identity_alias`).length,
      0,
      "failed stamp must roll back its alias",
    );
    yield* sql`INSERT INTO orchestration_v2_projection_messages
      (message_id,thread_id,role,streaming,created_at,updated_at,payload_json)
      VALUES ('message','thread','user',0,'2026-10-10','2026-10-10','{"text":"text"}')`;
    yield* stampV2MessageSender("message", sender);
    yield* stampV2MessageSender("message", sender);
    assert.deepStrictEqual(yield* readV2MessageSender("message"), {
      senderPublicId: "public",
      senderGeneration: "generation",
    });
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          stampV2MessageSender("message", { ...sender, generation: "replacement" }),
        ),
      ),
    );
    assert.deepStrictEqual(yield* readV2MessageSender("message"), {
      senderPublicId: "public",
      senderGeneration: "generation",
    });
    assert.strictEqual((yield* sql`SELECT * FROM throughline_message_sender`).length, 1);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("reconstructs sender from persisted metadata, with legacy rows still unknown", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    const insert = sql`INSERT INTO orchestration_v2_projection_messages
      (message_id,thread_id,role,streaming,created_at,updated_at,payload_json)
      VALUES ('replay','thread','user',0,'2026-10-11','2026-10-11','{"text":"replay"}')`;
    yield* insert;
    yield* stampV2MessageSender("replay", sender);
    yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE message_id='replay'`;
    yield* insert;
    assert.deepStrictEqual(yield* readV2MessageSender("replay"), {
      senderPublicId: "public",
      senderGeneration: "generation",
    });
    assert.isUndefined(yield* readV2MessageSender("legacy-unknown"));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("retains validation-only sender claims and persisted sender metadata/read fields", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    const claims = captureSenderClaims({ senderPublicId: "untrusted claim", senderGeneration: 17 });
    assert.deepStrictEqual(claims, [
      { field: "publicAgentId", value: "untrusted claim" },
      { field: "generation", value: 17 },
    ]);
    assert.isTrue(Exit.isFailure(yield* Effect.exit(assertSenderClaims(sender, claims))));
    yield* sql`INSERT INTO orchestration_v2_projection_messages
      (message_id,thread_id,role,streaming,created_at,updated_at,payload_json)
      VALUES ('stamped','thread','user',0,'2026-10-11','2026-10-11','{"text":"stamped"}'),
             ('unstamped','thread','user',0,'2026-10-11','2026-10-11','{"text":"unstamped"}')`;
    yield* stampV2MessageSender("stamped", sender);
    assert.deepStrictEqual(yield* readV2MessageSender("stamped"), {
      senderPublicId: "public",
      senderGeneration: "generation",
    });
    assert.isUndefined(yield* readV2MessageSender("unstamped"));
    assert.deepStrictEqual(
      yield* sql`SELECT sender_public_id,sender_generation FROM throughline_message_sender`,
      [{ sender_public_id: "public", sender_generation: "generation" }],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
