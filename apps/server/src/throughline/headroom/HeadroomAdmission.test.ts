// Controlled observer HTTP responses only; no account, credential or provider process.
// @effect-diagnostics nodeBuiltinImport:off
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  OrchestrationV2StoredEventJson,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Outbox from "../../orchestration-v2/EffectOutbox.ts";
import * as Projections from "../../orchestration-v2/ProjectionStore.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ProjectionObservation from "../observation/ProjectionObservation.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { BrokerStatusClient } from "./BrokerStatusClient.ts";
import { makeHeadroomAdmission as makeActualHeadroomAdmission } from "./HeadroomAdmission.ts";
import { readHeadroomWaits } from "./http.ts";
import { afterAll, vi } from "vite-plus/test";

// FetchHttpClient may keep its fetch function for the lifetime of its layer.
// Keep one controlled transport function; give every request a fresh body.
let controlledResponse = new Response("{}", { status: 500 });
const fetchTransport = vi
  .spyOn(globalThis, "fetch")
  .mockImplementation(async () => controlledResponse.clone());
afterAll(() => fetchTransport.mockRestore());
const makeHeadroomAdmission: typeof makeActualHeadroomAdmission = (base, client) =>
  makeActualHeadroomAdmission(base, client).pipe(
    Effect.map((admission) =>
      process.env.THROUGHLINE_HEADROOM_BASELINE === "1"
        ? { ...admission, executor: base }
        : admission,
    ),
  );

const id = ThreadId.make("headroom-thread");
const at = "2026-10-11T12:00:00.000Z";
const event = (type: string, payload: unknown) =>
  Schema.decodeUnknownSync(OrchestrationV2StoredEventJson)({
    sequence: 1,
    commandId: null,
    event: { id: `headroom:${type}`, threadId: id, occurredAt: at, type, payload },
  }).event;
const thread = event("thread.created", {
  id,
  projectId: "project",
  title: "Headroom",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "fixture" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: "/fixture",
  activeProviderThreadId: "provider-thread",
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});
const providerThread = event("provider-thread.updated", {
  id: "provider-thread",
  driver: "codex",
  providerInstanceId: "codex",
  providerSessionId: "provider-session",
  appThreadId: id,
  ownerNodeId: null,
  nativeThreadRef: null,
  nativeConversationHeadRef: null,
  status: "not_loaded",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  createdAt: at,
  updatedAt: at,
});
const run = event("run.created", {
  id: "run",
  threadId: id,
  ordinal: 1,
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "fixture" },
  providerThreadId: "provider-thread",
  userMessageId: "message",
  rootNodeId: null,
  activeAttemptId: null,
  status: "starting",
  requestedAt: at,
  startedAt: null,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
});
const effect: Outbox.OrchestrationEffectV2 = {
  id: "effect",
  commandId: CommandId.make("original-command"),
  threadId: id,
  request: { type: "provider-turn.start", runId: RunId.make("run") },
  status: "running",
  attemptCount: 1,
  availableAt: at,
  leaseOwner: "worker",
  leaseExpiresAt: null,
  createdAt: at,
  updatedAt: at,
  completedAt: null,
  lastError: null,
};
const fixture = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem,
        path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "throughline-headroom-" });
      const stores = Layer.mergeAll(
        EventStore.layer,
        Outbox.layer,
        ProjectionObservation.layer.pipe(Layer.provide(Projections.layer)),
      ).pipe(Layer.provideMerge(Sqlite.layerFromPath(path.join(directory, "state.sqlite"))));
      const runtime = EventSink.layer.pipe(Layer.provideMerge(stores));
      return yield* Effect.gen(function* () {
        yield* (yield* EventSink.EventSinkV2).write({ events: [thread, providerThread, run] });
        return yield* body;
      }).pipe(Effect.provide(runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer));

const withObserver = <A, E, R>(
  body: (
    client: BrokerStatusClient,
    refresh: (state: "empty" | "available") => Effect.Effect<void>,
    resetAt: string,
    syncClock: Effect.Effect<void>,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    let now = DateTime.toEpochMillis(yield* DateTime.now);
    const resetAt = DateTime.formatIso(DateTime.makeUnsafe(now + 30_000));
    const client = new BrokerStatusClient({
      statusUrl: "http://127.0.0.1:1/v1/status",
      freshnessMs: 60_000,
      now: () => now,
    });
    const response = (state: "empty" | "available") =>
      new Response(
        JSON.stringify({
          schema: "throughline-provider-broker.observer-status.v1",
          last_sequence: 1,
          identities: [
            {
              identity: "fixture-account",
              provider: "codex",
              credential_loaded: true,
              configured: true,
              quota: {
                state,
                observed_at: DateTime.formatIso(DateTime.makeUnsafe(now)),
                reset_at: resetAt,
              },
            },
          ],
        }),
        { status: 200 },
      );
    const refresh = (value: "empty" | "available") =>
      Effect.gen(function* () {
        now = DateTime.toEpochMillis(yield* DateTime.now);
        controlledResponse = response(value);
        yield* Effect.promise(() => client.refresh());
      });
    try {
      yield* refresh("empty");
      assert.equal(
        client.read().state,
        "fresh",
        "controlled observer response must enter the real cache",
      );
      assert.equal(
        client.read().identities[0]?.quota?.state,
        "empty",
        "known-empty fixture must not start as unknown",
      );
      return yield* body(
        client,
        refresh,
        resetAt,
        DateTime.now.pipe(
          Effect.tap((value) =>
            Effect.sync(() => {
              now = DateTime.toEpochMillis(value);
            }),
          ),
          Effect.asVoid,
        ),
      );
    } finally {
      client.close();
    }
  });

it.effect(
  "known-empty first run waits atomically with no invented provider session and truthful null upstream reset",
  () =>
    fixture(
      Effect.gen(function* () {
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const observedAt = DateTime.formatIso(DateTime.makeUnsafe(now));
        const resetAt = DateTime.formatIso(DateTime.makeUnsafe(now + 30_000));
        const client = new BrokerStatusClient({
          statusUrl: "http://127.0.0.1:1/v1/status",
          freshnessMs: 60_000,
          now: () => now,
        });
        controlledResponse = new Response(
          JSON.stringify({
            schema: "throughline-provider-broker.observer-status.v1",
            last_sequence: 1,
            identities: [
              {
                identity: "fixture-account",
                provider: "codex",
                credential_loaded: true,
                configured: true,
                quota: { state: "empty", observed_at: observedAt, reset_at: resetAt },
              },
            ],
          }),
          { status: 200 },
        );
        try {
          yield* Effect.promise(() => client.refresh());
          let starts = 0;
          const admission = yield* makeHeadroomAdmission(
            {
              execute: () =>
                Effect.sync(() => {
                  starts++;
                }),
            },
            client,
          );
          yield* admission.executor.execute(effect);
          assert.equal(starts, 0);
          const projections = yield* Projections.ProjectionStoreV2,
            sql = yield* SqlClient.SqlClient;
          const current = yield* projections.getThreadProjection(id);
          assert.equal(current.runs[0]!.status, "waiting");
          assert.lengthOf(current.providerSessions, 0);
          assert.isNull((yield* projections.getThreadShell(id))!.usageLimitResetAt);
          const rows = yield* sql<{
            reset_at: string;
            reason: string;
          }>`SELECT reset_at,reason FROM throughline_headroom_wait WHERE run_id='run'`;
          assert.deepEqual(rows, [
            { reset_at: resetAt, reason: "The observer reports no headroom until reset." },
          ]);
          assert.deepEqual(yield* readHeadroomWaits(id), {
            waits: [
              {
                runId: "run",
                resetAt,
                reason: "The observer reports no headroom until reset.",
                providerSessionVisible: false,
              },
            ],
          });
        } finally {
          client.close();
        }
      }),
    ),
);

it.effect(
  "fresh reset restores starting and atomically re-enqueues the same payload/command exactly once",
  () =>
    fixture(
      withObserver((client, refresh) =>
        Effect.gen(function* () {
          let startTurnCalls = 0;
          const controlledProvider = {
            startTurn: () =>
              Effect.sync(() => {
                startTurnCalls++;
              }),
          };
          const admission = yield* makeHeadroomAdmission(
            { execute: () => controlledProvider.startTurn() },
            client,
          );
          yield* admission.executor.execute(effect);
          yield* TestClock.adjust("30001 millis");
          yield* refresh("available");
          yield* admission.recheck;
          yield* admission.recheck;
          const outbox = yield* Outbox.EffectOutboxV2;
          const rows = yield* outbox.listByCommandId(effect.commandId);
          assert.lengthOf(rows, 1);
          assert.equal(rows[0]!.commandId, effect.commandId);
          assert.notEqual(rows[0]!.id, effect.id);
          assert.deepEqual(rows[0]!.request, effect.request);
          assert.equal(
            (yield* (yield* Projections.ProjectionStoreV2).getThreadProjection(id)).runs[0]!.status,
            "starting",
          );
          assert.lengthOf(
            yield* (yield* SqlClient.SqlClient)`SELECT * FROM throughline_headroom_wait`,
            0,
          );
          yield* admission.executor.execute(rows[0]!);
          assert.equal(startTurnCalls, 1);
        }),
      ),
    ),
);

it.effect(
  "a refused resume transaction leaves waiting and makes no second effect, then a fresh re-check succeeds",
  () =>
    fixture(
      withObserver((client, refresh) =>
        Effect.gen(function* () {
          const admission = yield* makeHeadroomAdmission({ execute: () => Effect.void }, client);
          yield* admission.executor.execute(effect);
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TRIGGER refuse_headroom_resume BEFORE INSERT ON orchestration_v2_effect_outbox BEGIN SELECT RAISE(ABORT,'fixture refusal'); END`;
          yield* TestClock.adjust("30001 millis");
          yield* refresh("available");
          yield* admission.recheck;
          assert.lengthOf(yield* sql`SELECT * FROM throughline_headroom_wait`, 1);
          assert.lengthOf(
            yield* (yield* Outbox.EffectOutboxV2).listByCommandId(effect.commandId),
            0,
          );
          assert.equal(
            (yield* (yield* Projections.ProjectionStoreV2).getThreadProjection(id)).runs[0]!.status,
            "waiting",
          );
          yield* sql`DROP TRIGGER refuse_headroom_resume`;
          yield* admission.recheck;
          assert.lengthOf(yield* sql`SELECT * FROM throughline_headroom_wait`, 0);
          assert.lengthOf(
            yield* (yield* Outbox.EffectOutboxV2).listByCommandId(effect.commandId),
            1,
          );
        }),
      ),
    ),
);

it.effect("unknown observer response proceeds without deferral or retry", () =>
  fixture(
    withObserver((client) =>
      Effect.gen(function* () {
        let starts = 0;
        const admission = yield* makeHeadroomAdmission(
          {
            execute: () =>
              Effect.sync(() => {
                starts++;
              }),
          },
          client,
        );
        client.close();
        yield* admission.executor.execute(effect);
        assert.equal(starts, 1);
        assert.lengthOf(
          yield* (yield* SqlClient.SqlClient)`SELECT * FROM throughline_headroom_wait`,
          0,
        );
      }),
    ),
  ),
);

it.effect(
  "stale observer response proceeds without treating transport receipt as quota freshness",
  () =>
    fixture(
      withObserver((client, _refresh, _reset, syncClock) =>
        Effect.gen(function* () {
          let starts = 0;
          const admission = yield* makeHeadroomAdmission(
            {
              execute: () =>
                Effect.sync(() => {
                  starts++;
                }),
            },
            client,
          );
          yield* TestClock.adjust("60001 millis");
          yield* syncClock;
          assert.equal(client.read().state, "stale");
          yield* admission.executor.execute(effect);
          assert.equal(starts, 1);
          assert.lengthOf(
            yield* (yield* SqlClient.SqlClient)`SELECT * FROM throughline_headroom_wait`,
            0,
          );
        }),
      ),
    ),
);

it.effect("existing session bytes are preserved while waiting and restored on atomic reset", () =>
  fixture(
    withObserver((client, refresh) =>
      Effect.gen(function* () {
        const session = event("provider-session.attached", {
          id: "provider-session",
          driver: "codex",
          providerInstanceId: "codex",
          status: "ready",
          cwd: "/actual-fixture-workspace",
          model: "fixture",
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: at,
          updatedAt: at,
          lastError: null,
        });
        const sink = yield* EventSink.EventSinkV2;
        yield* sink.write({ events: [session] });
        const admission = yield* makeHeadroomAdmission({ execute: () => Effect.void }, client);
        yield* admission.executor.execute(effect);
        const projections = yield* Projections.ProjectionStoreV2;
        const waiting = yield* projections.getThreadProjection(id);
        assert.equal(waiting.providerSessions[0]!.status, "waiting");
        assert.equal(
          waiting.providerSessions[0]!.lastError,
          "The observer reports no headroom until reset.",
        );
        assert.equal(waiting.providerSessions[0]!.cwd, "/actual-fixture-workspace");
        assert.deepEqual(waiting.providerSessions[0]!.capabilities, CodexProviderCapabilitiesV2);
        yield* TestClock.adjust("30001 millis");
        yield* refresh("available");
        yield* admission.recheck;
        const restored = yield* projections.getThreadProjection(id);
        assert.equal(restored.providerSessions[0]!.status, "ready");
        assert.isNull(restored.providerSessions[0]!.lastError);
        assert.equal(restored.providerSessions[0]!.cwd, "/actual-fixture-workspace");
        assert.deepEqual(restored.providerSessions[0]!.capabilities, CodexProviderCapabilitiesV2);
      }),
    ),
  ),
);

for (const status of ["cancelled", "rolled_back"] as const)
  it.effect(`${status} removes the deferral with the actual run transaction`, () =>
    fixture(
      withObserver((client) =>
        Effect.gen(function* () {
          const admission = yield* makeHeadroomAdmission({ execute: () => Effect.void }, client);
          yield* admission.executor.execute(effect);
          const projection = yield* (yield* Projections.ProjectionStoreV2).getThreadProjection(id);
          yield* (yield* EventSink.EventSinkV2).write({
            events: [
              {
                id: EventId.make("cancel-headroom"),
                type: "run.updated",
                threadId: id,
                occurredAt: yield* DateTime.now,
                payload: { ...projection.runs[0]!, status },
              },
            ],
          });
          assert.lengthOf(
            yield* (yield* SqlClient.SqlClient)`SELECT * FROM throughline_headroom_wait`,
            0,
          );
        }),
      ),
    ),
  );

it.effect("changed provider/native lineage drops the wait and never wakes the old provider", () =>
  fixture(
    withObserver((client, refresh) =>
      Effect.gen(function* () {
        const admission = yield* makeHeadroomAdmission({ execute: () => Effect.void }, client);
        yield* admission.executor.execute(effect);
        const projections = yield* Projections.ProjectionStoreV2;
        const current = yield* projections.getThreadProjection(id);
        yield* (yield* EventSink.EventSinkV2).write({
          events: [
            {
              id: EventId.make("headroom-lineage-replaced"),
              type: "provider-thread.updated",
              threadId: id,
              occurredAt: yield* DateTime.now,
              payload: {
                ...current.providerThreads[0]!,
                providerSessionId: null,
                nativeThreadRef: {
                  driver: current.providerThreads[0]!.driver,
                  nativeId: "replacement-native",
                  strength: "strong",
                },
              },
            },
          ],
        });
        assert.deepEqual(yield* readHeadroomWaits(id), { waits: [] });
        yield* TestClock.adjust("30001 millis");
        yield* refresh("available");
        yield* admission.recheck;
        assert.lengthOf(
          yield* (yield* SqlClient.SqlClient)`SELECT * FROM throughline_headroom_wait`,
          0,
        );
        assert.lengthOf(yield* (yield* Outbox.EffectOutboxV2).listByCommandId(effect.commandId), 0);
      }),
    ),
  ),
);

it.effect("rewind lineage invalidates the deferred run and wakes nothing", () =>
  fixture(
    withObserver((client, refresh) =>
      Effect.gen(function* () {
        const admission = yield* makeHeadroomAdmission({ execute: () => Effect.void }, client);
        yield* admission.executor.execute(effect);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO throughline_rewind_cut (thread_id,provider_thread_id,native_session_id,resume_at,source_tip_run_ordinal,source_tip_sequence)
    VALUES (${id},'provider-thread','native','cursor',1,99999)`;
        yield* TestClock.adjust("30001 millis");
        yield* refresh("available");
        yield* admission.recheck;
        assert.lengthOf(yield* sql`SELECT * FROM throughline_headroom_wait`, 0);
        assert.lengthOf(yield* (yield* Outbox.EffectOutboxV2).listByCommandId(effect.commandId), 0);
        assert.equal(
          (yield* (yield* Projections.ProjectionStoreV2).getThreadProjection(id)).runs[0]!.status,
          "waiting",
        );
      }),
    ),
  ),
);
