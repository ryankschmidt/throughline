import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Auth from "../../auth/EnvironmentAuth.ts";

/** Recorded, still-live deferrals only. An empty result is not available quota. */
export const readHeadroomWaits = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      runId: string;
      resetAt: string;
      reason: string;
      sessionEventEmitted: number;
    }>`
    SELECT w.run_id AS "runId",w.reset_at AS "resetAt",w.reason,w.session_event_emitted AS "sessionEventEmitted"
    FROM throughline_headroom_wait w
    JOIN orchestration_v2_projection_runs r ON r.run_id=w.run_id AND r.thread_id=w.thread_id
    JOIN orchestration_v2_projection_threads t ON t.thread_id=w.thread_id
    JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id=w.provider_thread_id
    WHERE w.thread_id=${threadId} AND r.status='waiting'
      AND json_extract(t.payload_json,'$.activeProviderThreadId')=w.provider_thread_id
      AND json_extract(p.payload_json,'$.providerSessionId') IS w.provider_session_id
      AND json_extract(p.payload_json,'$.nativeThreadRef.nativeId') IS w.native_session_id
      AND NOT EXISTS (SELECT 1 FROM throughline_rewind_cut cut WHERE cut.thread_id=w.thread_id AND cut.source_tip_sequence>=w.deferral_sequence)
    ORDER BY w.deferral_sequence,w.run_id`;
    return {
      waits: rows.map(({ sessionEventEmitted, ...row }) => ({
        ...row,
        providerSessionVisible: sessionEventEmitted === 1,
      })),
    };
  });

export const headroomRouteLayer = HttpRouter.add(
  "GET",
  "/throughline/threads/:threadId/headroom",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest,
      auth = yield* Auth.EnvironmentAuth;
    const session = yield* Effect.exit(auth.authenticateHttpRequest(request));
    const headers = { "cache-control": "no-store" };
    if (Exit.isFailure(session))
      return HttpServerResponse.jsonUnsafe({ error: "auth_required" }, { status: 401, headers });
    if (!session.value.scopes.includes(AuthOrchestrationReadScope))
      return HttpServerResponse.jsonUnsafe({ error: "scope_required" }, { status: 403, headers });
    const params = yield* HttpRouter.params;
    return HttpServerResponse.jsonUnsafe(yield* readHeadroomWaits(params.threadId!), { headers });
  }),
);
