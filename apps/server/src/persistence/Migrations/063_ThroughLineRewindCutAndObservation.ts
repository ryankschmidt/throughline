import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS throughline_rewind_cut (
    thread_id TEXT PRIMARY KEY,
    provider_thread_id TEXT NOT NULL,
    native_session_id TEXT NOT NULL,
    resume_at TEXT NOT NULL,
    target_message_id TEXT,
    target_run_ordinal INTEGER CHECK(target_run_ordinal IS NULL OR target_run_ordinal >= 0),
    source_tip_run_ordinal INTEGER NOT NULL CHECK(source_tip_run_ordinal >= 0),
    source_tip_sequence INTEGER NOT NULL CHECK(source_tip_sequence >= 0),
    recovery_state TEXT NOT NULL DEFAULT 'pending' CHECK(recovery_state IN ('pending','recovered','refused')),
    refusal_reason TEXT,
    committed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS throughline_thread_identity (
    thread_id TEXT PRIMARY KEY,
    provider_thread_id TEXT NOT NULL,
    provider_session_id TEXT,
    native_session_id TEXT,
    native_transcript_path TEXT
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS throughline_run_observation (
    run_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    requested_model TEXT,
    answering_model TEXT,
    source TEXT CHECK(source IS NULL OR source = 'provider-event'),
    scope TEXT NOT NULL DEFAULT 'main-run' CHECK(scope = 'main-run')
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS throughline_settings_record (
    command_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    item_id TEXT NOT NULL UNIQUE,
    environment_id TEXT NOT NULL,
    owner TEXT NOT NULL CHECK(owner = 'OrchestrationEngine'),
    kind TEXT NOT NULL,
    tone TEXT NOT NULL,
    record_json TEXT NOT NULL CHECK(json_valid(record_json)),
    evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256) = 64),
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS throughline_headroom_wait (
    run_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    command_id TEXT NOT NULL,
    effect_id TEXT NOT NULL,
    effect_json TEXT NOT NULL CHECK(json_valid(effect_json)),
    provider_thread_id TEXT NOT NULL,
    provider_session_id TEXT,
    native_session_id TEXT,
    pre_deferral_run_status TEXT NOT NULL CHECK(pre_deferral_run_status='starting'),
    pre_deferral_session_status TEXT,
    session_event_emitted INTEGER NOT NULL CHECK(session_event_emitted IN (0,1)),
    deferral_sequence INTEGER NOT NULL CHECK(deferral_sequence>=0),
    reset_at TEXT NOT NULL,
    reason TEXT NOT NULL,
    generation TEXT NOT NULL
  )`;
});
