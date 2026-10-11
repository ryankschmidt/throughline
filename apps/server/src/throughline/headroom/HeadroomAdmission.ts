import { CommandId, EventId, ThreadId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Executor from "../../orchestration-v2/EffectWorker.ts";
import * as Outbox from "../../orchestration-v2/EffectOutbox.ts";
import * as Projections from "../../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import { BrokerStatusClient } from "./BrokerStatusClient.ts";
import { readHeadroom } from "./observer.ts";
import {
  CurrentHeadroomWait,
  HEADROOM_REASON,
  type HeadroomWaitRow,
} from "./HeadroomWaitRecord.ts";

const effectCodec = Schema.fromJsonString(Outbox.OrchestrationEffectRequestV2);
export const DEFAULT_HEADROOM_STATUS_URL = "http://127.0.0.1:19444/v1/status";
export const CurrentHeadroomStatusUrl = Context.Reference<string | undefined>(
  "t3/throughline/headroom/CurrentHeadroomStatusUrl",
  { defaultValue: () => DEFAULT_HEADROOM_STATUS_URL },
);
const generationCodec = Schema.fromJsonString(
  Schema.Struct({
    runId: Schema.String,
    providerThreadId: Schema.String,
    providerSessionId: Schema.NullOr(Schema.String),
    nativeSessionId: Schema.NullOr(Schema.String),
    sequence: Schema.Number,
  }),
);
export class HeadroomAdmission extends Context.Service<
  HeadroomAdmission,
  {
    readonly recheck: Effect.Effect<void>;
    readonly pollingStarted: boolean;
  }
>()("t3/throughline/headroom/HeadroomAdmission") {}

export const makeHeadroomAdmission = Effect.fn("headroom.makeAdmission")(function* (
  base: Executor.OrchestrationEffectExecutorV2Shape,
  client: BrokerStatusClient,
) {
  const projections = yield* Projections.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const events = yield* EventStore.EventStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const read = (driver: string, now: number) => {
    const cached = client.read();
    const provider = driver === "claudeAgent" ? "claude" : driver;
    const configured = cached.identities
      .filter((row) => row.provider === provider && row.configured !== false)
      .map(({ identity, provider }) => ({ identity, provider }));
    const keys = new Set(configured.map((row) => JSON.stringify([row.provider, row.identity])));
    const snapshot =
      cached.snapshot === undefined
        ? undefined
        : {
            identities: cached.snapshot.identities.filter((row) =>
              keys.has(JSON.stringify([row.provider, row.identity])),
            ),
          };
    return {
      cached,
      rows: readHeadroom({ configured, snapshot, freshnessMs: client.freshnessMs, now }),
    };
  };
  const execute: Executor.OrchestrationEffectExecutorV2Shape["execute"] = (effect, options) => {
    if (effect.request.type !== "provider-turn.start") return base.execute(effect, options);
    const runId = effect.request.runId;
    return Effect.gen(function* () {
      const projection = yield* projections.getThreadRecords(effect.threadId, [
        "providerThreads",
        "providerSessions",
        "runs",
      ]);
      const run = projection.runs.find((row) => row.id === runId);
      const providerThread = projection.providerThreads.find(
        (row) => row.id === run?.providerThreadId,
      );
      if (run?.status !== "starting" || providerThread === undefined)
        return yield* base.execute(effect, options);
      const now = yield* DateTime.now;
      const observation = read(providerThread.driver, DateTime.toEpochMillis(now));
      if (
        observation.cached.state !== "fresh" ||
        observation.rows.length === 0 ||
        observation.rows.some((row) => row.admit || row.reset_at === null)
      )
        return yield* base.execute(effect, options);
      const reset = observation.rows
        .map((row) => DateTime.makeUnsafe(row.reset_at!))
        .toSorted((a, b) => DateTime.toEpochMillis(a) - DateTime.toEpochMillis(b))[0]!;
      const session = projection.providerSessions.find(
        (row) => row.id === providerThread.providerSessionId,
      );
      const sequence = yield* events.latestSequence({ threadId: effect.threadId });
      const row: HeadroomWaitRow = {
        run_id: run.id,
        thread_id: effect.threadId,
        command_id: effect.commandId,
        effect_id: effect.id,
        effect_json: yield* Schema.encodeEffect(effectCodec)(effect.request),
        provider_thread_id: providerThread.id,
        provider_session_id: providerThread.providerSessionId,
        native_session_id: providerThread.nativeThreadRef?.nativeId ?? null,
        pre_deferral_run_status: "starting",
        pre_deferral_session_status: session?.status ?? null,
        session_event_emitted: session === undefined ? 0 : 1,
        deferral_sequence: sequence,
        reset_at: DateTime.formatIso(reset),
        reason: HEADROOM_REASON,
        generation: yield* Schema.encodeEffect(generationCodec)({
          runId: run.id,
          providerThreadId: providerThread.id,
          providerSessionId: providerThread.providerSessionId,
          nativeSessionId: providerThread.nativeThreadRef?.nativeId ?? null,
          sequence,
        }),
      };
      const updates: OrchestrationV2DomainEvent[] = [
        {
          id: EventId.make(`headroom:${effect.id}:waiting`),
          threadId: effect.threadId,
          type: "run.updated",
          occurredAt: now,
          payload: { ...run, status: "waiting" },
        },
      ];
      if (session !== undefined)
        updates.push({
          id: EventId.make(`headroom:${effect.id}:session-waiting`),
          threadId: effect.threadId,
          type: "provider-session.updated",
          occurredAt: now,
          payload: { ...session, status: "waiting", lastError: HEADROOM_REASON, updatedAt: now },
        });
      yield* sink
        .write({ commandId: effect.commandId, events: updates })
        .pipe(Effect.provideService(CurrentHeadroomWait, { action: "defer", row }));
    }).pipe(
      Effect.mapError(
        (cause) =>
          new Executor.OrchestrationEffectExecutionError({
            effectId: effect.id,
            effectType: effect.request.type,
            cause,
          }),
      ),
    );
  };
  const recheck = Effect.gen(function* () {
    const waits = yield* sql<HeadroomWaitRow>`SELECT * FROM throughline_headroom_wait`;
    for (const row of waits) {
      yield* Effect.gen(function* () {
        const threadId = ThreadId.make(row.thread_id);
        const projection = yield* projections.getThreadRecords(threadId, [
          "providerThreads",
          "providerSessions",
          "runs",
        ]);
        const run = projection.runs.find((value) => value.id === row.run_id);
        const provider = projection.providerThreads.find(
          (value) => value.id === row.provider_thread_id,
        );
        const cut =
          yield* sql`SELECT thread_id FROM throughline_rewind_cut WHERE thread_id=${row.thread_id} AND source_tip_sequence>=${row.deferral_sequence}`;
        if (
          run?.status !== "waiting" ||
          projection.thread.activeProviderThreadId !== row.provider_thread_id ||
          provider === undefined ||
          provider.providerSessionId !== row.provider_session_id ||
          (provider.nativeThreadRef?.nativeId ?? null) !== row.native_session_id ||
          cut.length > 0
        ) {
          yield* sql`DELETE FROM throughline_headroom_wait WHERE run_id=${row.run_id} AND generation=${row.generation}`;
          yield* Effect.logInfo("Headroom wait dropped: run/provider lineage superseded", {
            threadId: row.thread_id,
            runId: row.run_id,
          });
          return;
        }
        const now = yield* DateTime.now;
        const observation = read(provider.driver, DateTime.toEpochMillis(now));
        if (
          observation.cached.state !== "fresh" ||
          DateTime.toEpochMillis(now) < DateTime.toEpochMillis(DateTime.makeUnsafe(row.reset_at)) ||
          observation.rows.length === 0 ||
          !observation.rows.some((value) => value.admit && value.freshness === "fresh")
        )
          return;
        const request = yield* Schema.decodeUnknownEffect(effectCodec)(row.effect_json);
        if (request.type !== "provider-turn.start" || request.runId !== row.run_id)
          throw new Error("Stored headroom effect is not its run's start");
        const session = projection.providerSessions.find(
          (value) => value.id === row.provider_session_id,
        );
        const updates: OrchestrationV2DomainEvent[] = [
          {
            id: EventId.make(`headroom:${row.effect_id}:resume:${row.deferral_sequence}`),
            threadId,
            type: "run.updated",
            occurredAt: now,
            payload: { ...run, status: row.pre_deferral_run_status },
          },
        ];
        if (row.session_event_emitted === 1) {
          if (session === undefined) throw new Error("Deferred provider session disappeared");
          const status = yield* Schema.decodeUnknownEffect(
            Schema.Literals(["starting", "ready", "running", "waiting", "stopped", "error"]),
          )(row.pre_deferral_session_status);
          updates.push({
            id: EventId.make(`headroom:${row.effect_id}:session-resume:${row.deferral_sequence}`),
            threadId,
            type: "provider-session.updated",
            occurredAt: now,
            payload: { ...session, status, lastError: null, updatedAt: now },
          });
        }
        yield* sink
          .writeWithEffects({
            commandId: CommandId.make(row.command_id),
            events: updates,
            effects: [
              {
                id: `headroom:${row.effect_id}:resume:${row.deferral_sequence}`,
                commandId: CommandId.make(row.command_id),
                threadId,
                request,
              },
            ],
          })
          .pipe(Effect.provideService(CurrentHeadroomWait, { action: "resume", row }));
      }).pipe(
        Effect.catchCause(() =>
          Effect.logWarning("Headroom reset re-check refused; wait remains", {
            threadId: row.thread_id,
            runId: row.run_id,
          }),
        ),
      );
    }
  }).pipe(
    Effect.catchCause(() =>
      Effect.logWarning("Headroom wait inventory unavailable; no wake issued"),
    ),
  );
  return { executor: { execute }, recheck };
});

/** One cache lifetime per production executor scope; no usage request on a turn path. */
export const layer = Layer.effectContext(
  Effect.gen(function* () {
    const base = yield* Executor.OrchestrationEffectExecutorV2;
    const statusUrl = yield* CurrentHeadroomStatusUrl;
    const client = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new BrokerStatusClient({
            ...(statusUrl === undefined ? {} : { statusUrl }),
            freshnessMs: 60_000,
          }),
      ),
      (value) => Effect.sync(() => value.close()),
    );
    const admission = yield* makeHeadroomAdmission(base, client);
    const pollingStarted = statusUrl !== undefined;
    if (pollingStarted) {
      let changed = yield* Deferred.make<void>();
      const refresh = Effect.gen(function* () {
        yield* Effect.promise(() => client.refresh());
        const completed = changed;
        changed = yield* Deferred.make<void>();
        yield* Deferred.succeed(completed, undefined);
        yield* admission.recheck;
      });
      yield* refresh.pipe(Effect.forkScoped);
      yield* Effect.forever(Effect.sleep("30 seconds").pipe(Effect.andThen(refresh))).pipe(
        Effect.forkScoped,
      );
    }
    return Context.make(Executor.OrchestrationEffectExecutorV2, admission.executor).pipe(
      Context.add(HeadroomAdmission, { recheck: admission.recheck, pollingStarted }),
    );
  }),
);
