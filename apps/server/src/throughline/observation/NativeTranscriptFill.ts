import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { resolveClaudeNativeTranscriptPath } from "../identity/native-lineage.ts";

const decodeProvider = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      driver: Schema.String,
      providerInstanceId: Schema.String,
    }),
  ),
);

/** Called from the identity GET after commit, never from projection apply. */
export const fillNativeTranscriptPath = (
  threadId: string,
  lookup = resolveClaudeNativeTranscriptPath,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      provider_thread_id: string;
      native_session_id: string;
      payload_json: string;
    }>`
      SELECT identity.provider_thread_id, identity.native_session_id, provider.payload_json
      FROM throughline_thread_identity identity
      JOIN orchestration_v2_projection_provider_threads provider
        ON provider.provider_thread_id = identity.provider_thread_id
      WHERE identity.thread_id=${threadId} AND identity.native_transcript_path IS NULL
        AND identity.native_session_id IS NOT NULL`;
    const row = rows[0];
    if (row === undefined) return;
    const provider = decodeProvider(row.payload_json);
    if (Option.isNone(provider) || provider.value.driver !== "claudeAgent") return;
    const path = yield* Effect.tryPromise(() =>
      lookup(row.native_session_id, process.env.CLAUDE_CONFIG_DIR),
    ).pipe(Effect.orElseSucceed(() => undefined));
    if (path === undefined) return;
    yield* sql`UPDATE throughline_thread_identity SET native_transcript_path=${path}
      WHERE thread_id=${threadId} AND provider_thread_id=${row.provider_thread_id}
        AND native_session_id=${row.native_session_id} AND native_transcript_path IS NULL`;
  });
