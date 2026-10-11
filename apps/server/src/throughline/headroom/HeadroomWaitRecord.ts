import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export const HEADROOM_REASON = "The observer reports no headroom until reset.";
export interface HeadroomWaitRow {
  readonly run_id: string;
  readonly thread_id: string;
  readonly command_id: string;
  readonly effect_id: string;
  readonly effect_json: string;
  readonly provider_thread_id: string;
  readonly provider_session_id: string | null;
  readonly native_session_id: string | null;
  readonly pre_deferral_run_status: "starting";
  readonly pre_deferral_session_status: string | null;
  readonly session_event_emitted: number;
  readonly deferral_sequence: number;
  readonly reset_at: string;
  readonly reason: string;
  readonly generation: string;
}
export const CurrentHeadroomWait = Context.Reference<
  { readonly action: "defer" | "resume"; readonly row: HeadroomWaitRow } | undefined
>("t3/throughline/headroom/CurrentHeadroomWait", { defaultValue: () => undefined });

/** This precondition and the subsequent stamp both run on apply's transaction client. */
export const validateHeadroomTransition = (event: OrchestrationV2DomainEvent) =>
  Effect.gen(function* () {
    const context = yield* CurrentHeadroomWait;
    if (
      context === undefined ||
      event.type !== "run.updated" ||
      event.payload.id !== context.row.run_id
    )
      return;
    const sql = yield* SqlClient.SqlClient;
    const row = context.row;
    const live = yield* sql<{
      status: string;
      active: string | null;
      session: string | null;
      native: string | null;
    }>`
    SELECT r.status, json_extract(t.payload_json,'$.activeProviderThreadId') AS active,
      json_extract(p.payload_json,'$.providerSessionId') AS session,
      json_extract(p.payload_json,'$.nativeThreadRef.nativeId') AS native
    FROM orchestration_v2_projection_runs r
    JOIN orchestration_v2_projection_threads t ON t.thread_id=r.thread_id
    JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id=${row.provider_thread_id}
    WHERE r.run_id=${row.run_id} AND r.thread_id=${row.thread_id}`;
    const value = live[0];
    if (
      live.length !== 1 ||
      value === undefined ||
      value.status !== (context.action === "defer" ? "starting" : "waiting") ||
      value.active !== row.provider_thread_id ||
      value.session !== row.provider_session_id ||
      value.native !== row.native_session_id
    )
      throw new Error("Headroom lineage/run changed before transaction");
    if (context.action === "resume") {
      const cut =
        yield* sql`SELECT thread_id FROM throughline_rewind_cut WHERE thread_id=${row.thread_id} AND source_tip_sequence>=${row.deferral_sequence}`;
      const wait =
        yield* sql`SELECT run_id FROM throughline_headroom_wait WHERE run_id=${row.run_id} AND generation=${row.generation}`;
      if (cut.length > 0 || wait.length !== 1)
        throw new Error("Headroom wait was superseded before transaction");
    }
  });

export const stampHeadroomWait = (event: OrchestrationV2DomainEvent) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const context = yield* CurrentHeadroomWait;
    if (
      event.type === "run.updated" &&
      context !== undefined &&
      event.payload.id === context.row.run_id
    ) {
      const row = context.row;
      if (context.action === "resume") {
        yield* sql`DELETE FROM throughline_headroom_wait WHERE run_id=${row.run_id} AND generation=${row.generation}`;
      } else {
        yield* sql`INSERT INTO throughline_headroom_wait
        (run_id,thread_id,command_id,effect_id,effect_json,provider_thread_id,provider_session_id,native_session_id,
         pre_deferral_run_status,pre_deferral_session_status,session_event_emitted,deferral_sequence,reset_at,reason,generation)
        VALUES (${row.run_id},${row.thread_id},${row.command_id},${row.effect_id},${row.effect_json},${row.provider_thread_id},
         ${row.provider_session_id},${row.native_session_id},${row.pre_deferral_run_status},${row.pre_deferral_session_status},
         ${row.session_event_emitted},${row.deferral_sequence},${row.reset_at},${row.reason},${row.generation})
        ON CONFLICT(run_id) DO NOTHING`;
      }
    }
    if (
      event.type === "run.updated" &&
      ["cancelled", "interrupted", "rolled_back", "failed", "completed"].includes(
        event.payload.status,
      )
    ) {
      yield* sql`DELETE FROM throughline_headroom_wait WHERE run_id=${event.payload.id}`;
    }
  });
