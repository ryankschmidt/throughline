import { assert, it } from "@effect/vitest";
import { OrchestrationV2StoredEventJson } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import { observeEvents } from "./EventSinkObservation.ts";

const at = "2026-10-11T12:00:00.000Z";
const stored = (type: string, payload: unknown) =>
  Schema.decodeUnknownSync(OrchestrationV2StoredEventJson)({
    sequence: 1,
    commandId: null,
    event: { id: "event", threadId: "thread", type, occurredAt: at, payload },
  });

it.effect(
  "keeps requested model separate from unknown answering model using the actual V2 event schema",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const run = stored("run.created", {
        id: "run",
        threadId: "thread",
        ordinal: 1,
        providerInstanceId: "claudeAgent",
        modelSelection: { instanceId: "claudeAgent", model: "requested" },
        providerThreadId: null,
        userMessageId: "message",
        rootNodeId: null,
        activeAttemptId: null,
        status: "queued",
        requestedAt: at,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      });
      yield* observeEvents([run]);
      assert.deepStrictEqual(
        yield* sql`SELECT requested_model,answering_model,source FROM throughline_run_observation`,
        [{ requested_model: "requested", answering_model: null, source: null }],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "records owning-environment native identity without inventing a missing transcript path",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const thread = stored("provider-thread.updated", {
        id: "provider-thread",
        driver: "claudeAgent",
        providerInstanceId: "claudeAgent",
        providerSessionId: "session",
        appThreadId: "thread",
        ownerNodeId: null,
        nativeThreadRef: { driver: "claudeAgent", nativeId: "native", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: at,
        updatedAt: at,
      });
      yield* observeEvents([thread], { transcriptPath: async () => undefined });
      assert.deepStrictEqual(
        yield* sql`SELECT native_session_id,native_transcript_path FROM throughline_thread_identity`,
        [{ native_session_id: "native", native_transcript_path: null }],
      );
      yield* observeEvents([thread], {
        transcriptPath: async () => "/fixture/provider/native.jsonl",
      });
      assert.deepStrictEqual(
        yield* sql`SELECT native_transcript_path FROM throughline_thread_identity`,
        [{ native_transcript_path: null }],
        "apply never performs transcript filesystem lookup inside a transaction",
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
