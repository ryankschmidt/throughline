import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, EnvironmentId, OrchestrationV2StoredEventJson } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Projections from "../../orchestration-v2/ProjectionStore.ts";
import * as Receipts from "../../orchestration-v2/CommandReceiptStore.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ProjectionObservation from "../observation/ProjectionObservation.ts";
import { ServerEnvironmentIdentity } from "../../environment/ServerEnvironment.ts";
import { makeExistingSettingsConsumer } from "./ExistingSettingsConsumerV2.ts";
import {
  createHostBindings,
  UnconfirmedSettingsRecordError,
  type SettingsBindingRecord,
} from "./HostBindings.ts";

const at = "2026-10-11T12:00:00.000Z";
const context = {
  owner: "OrchestrationEngine" as const,
  environmentId: "environment",
  threadId: "settings-thread",
};
const record: SettingsBindingRecord = {
  operation: "apply",
  bindings: {
    source: "reviewed-source",
    revision: "one",
    hosts: [
      { role: "mac", environmentId: "environment" },
      { role: "twr", environmentId: "tower" },
      { role: "rpi", environmentId: "rpi" },
    ],
  },
  event: {
    setting: "continueThreadsAfterServerUpdate",
    value: true,
    hosts: [
      { host: "mac", before: false, effective: true, status: "applied" },
      { host: "twr", before: false, effective: true, status: "applied" },
      { host: "rpi", before: true, effective: true, status: "unchanged" },
    ],
  },
};
const thread = Schema.decodeUnknownSync(OrchestrationV2StoredEventJson)({
  sequence: 1,
  commandId: null,
  event: {
    id: "settings-seed",
    type: "thread.created",
    threadId: context.threadId,
    occurredAt: at,
    payload: {
      id: context.threadId,
      projectId: "project",
      title: "Settings fixture",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: context.threadId },
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
    },
  },
}).event;
const options = {
  context,
  authorize: () => Effect.succeed(true),
  mapActivity: () => ({
    commandId: CommandId.make("settings-operation"),
    createdAt: at,
    activity: {
      id: "throughline-settings:activity",
      tone: "info",
      kind: "settings-host-result",
      summary: "Continuation settings applied.",
      createdAt: at,
    },
  }),
};
const Authorize = Context.Reference<boolean>("test/settings-authorization", {
  defaultValue: () => false,
});

const runtime = (file: string) => {
  const stores = Layer.mergeAll(
    EventStore.layer,
    Receipts.layer,
    ProjectionObservation.layer.pipe(Layer.provide(Projections.layer)),
  ).pipe(Layer.provideMerge(Sqlite.layerFromPath(file)));
  return EventSink.layer.pipe(
    Layer.provideMerge(stores),
    Layer.provideMerge(
      Layer.succeed(ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
      }),
    ),
  );
};
function fixture<A, E, R>(body: (file: string) => Effect.Effect<A, E, R>) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem,
        path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "throughline-settings-record-",
      });
      const file = path.join(directory, "state.sqlite");
      yield* Effect.gen(function* () {
        yield* (yield* EventSink.EventSinkV2).write({ events: [thread] });
      }).pipe(Effect.provide(runtime(file)));
      return yield* body(file);
    }),
  ).pipe(Effect.provide(NodeServices.layer));
}

it.effect(
  "appends one actual activity with a matching durable receipt and refuses same-id different evidence",
  () =>
    fixture((file) =>
      Effect.gen(function* () {
        const consumer = yield* makeExistingSettingsConsumer(options);
        const receipt = yield* Effect.promise(() => consumer.append(record, context));
        assert.isAbove(receipt.sequence, 0);
        assert.deepEqual(yield* Effect.promise(() => consumer.append(record, context)), receipt);
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(yield* sql`SELECT COUNT(*) AS n FROM throughline_settings_record`, [
          { n: 1 },
        ]);
        const notice = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id='throughline-settings:activity'`;
        const payload = JSON.parse(notice[0]!.payload_json) as { message: string; runId: null };
        assert.equal(payload.message, "Continuation settings applied.");
        assert.isNull(payload.runId);
        const failure = yield* Effect.tryPromise({
          try: () =>
            consumer.append({ ...record, event: { ...record.event, value: false } }, context),
          catch: (error) =>
            error instanceof UnconfirmedSettingsRecordError
              ? error
              : new UnconfirmedSettingsRecordError(record),
        }).pipe(Effect.flip);
        assert.instanceOf(failure, UnconfirmedSettingsRecordError);
        assert.deepEqual(
          yield* sql`SELECT COUNT(*) AS n FROM orchestration_events WHERE command_id='settings-operation'`,
          [{ n: 1 }],
        );
      }).pipe(Effect.provide(runtime(file))),
    ),
);

it.effect(
  "keeps captured Effect authorization context and typed failures when called through the Promise adapter",
  () =>
    fixture((file) =>
      Effect.gen(function* () {
        const consumer = yield* makeExistingSettingsConsumer({
          ...options,
          authorize: () => Authorize,
        }).pipe(Effect.provideService(Authorize, true));
        assert.isTrue(yield* Effect.promise(() => consumer.verifyExistingContext(context)));
        const refused = yield* makeExistingSettingsConsumer({
          ...options,
          authorize: () => Authorize,
        });
        assert.isFalse(yield* Effect.promise(() => refused.verifyExistingContext(context)));
      }).pipe(Effect.provide(runtime(file))),
    ),
);

it.effect(
  "refuses wrong environment, absent/deleted thread and expired authorization before appending",
  () =>
    fixture((file) =>
      Effect.gen(function* () {
        const consumer = yield* makeExistingSettingsConsumer(options);
        assert.isFalse(
          yield* Effect.promise(() =>
            consumer.verifyExistingContext({ ...context, environmentId: "wrong" }),
          ),
        );
        const missing = yield* makeExistingSettingsConsumer({
          ...options,
          context: { ...context, threadId: "absent" },
        });
        assert.isFalse(
          yield* Effect.promise(() =>
            missing.verifyExistingContext({ ...context, threadId: "absent" }),
          ),
        );
        const expired = yield* makeExistingSettingsConsumer({
          ...options,
          authorize: () => Effect.succeed(false),
        });
        assert.isFalse(yield* Effect.promise(() => expired.verifyExistingContext(context)));
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at=${at}, payload_json=json_set(payload_json,'$.deletedAt',${at}) WHERE thread_id=${context.threadId}`;
        assert.isFalse(yield* Effect.promise(() => consumer.verifyExistingContext(context)));
      }).pipe(Effect.provide(runtime(file))),
    ),
);

it.effect("a stamp failure rolls the notice and record back together", () =>
  fixture((file) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TRIGGER fixture_refuse_settings BEFORE INSERT ON throughline_settings_record BEGIN SELECT RAISE(ABORT,'fixture stamp refusal'); END`;
      const consumer = yield* makeExistingSettingsConsumer(options);
      const failure = yield* Effect.tryPromise({
        try: () => consumer.append(record, context),
        catch: (error) =>
          error instanceof UnconfirmedSettingsRecordError
            ? error
            : new UnconfirmedSettingsRecordError(record),
      }).pipe(Effect.flip);
      assert.instanceOf(failure, UnconfirmedSettingsRecordError);
      assert.deepEqual(yield* sql`SELECT COUNT(*) AS n FROM throughline_settings_record`, [
        { n: 0 },
      ]);
      assert.deepEqual(
        yield* sql`SELECT COUNT(*) AS n FROM orchestration_v2_projection_turn_items WHERE turn_item_id='throughline-settings:activity'`,
        [{ n: 0 }],
      );
      assert.deepEqual(
        yield* sql`SELECT COUNT(*) AS n FROM orchestration_events WHERE command_id='settings-operation'`,
        [{ n: 0 }],
      );
    }).pipe(Effect.provide(runtime(file))),
  ),
);

it.effect(
  "reopens the existing SQLite owner and corroborates the same accepted operation without another event",
  () =>
    fixture((file) =>
      Effect.gen(function* () {
        const first = yield* Effect.gen(function* () {
          const consumer = yield* makeExistingSettingsConsumer(options);
          return yield* Effect.promise(() => consumer.append(record, context));
        }).pipe(Effect.provide(runtime(file)));
        yield* Effect.gen(function* () {
          const consumer = yield* makeExistingSettingsConsumer(options);
          assert.deepEqual(yield* Effect.promise(() => consumer.append(record, context)), first);
          const sql = yield* SqlClient.SqlClient;
          assert.deepEqual(
            yield* sql`SELECT COUNT(*) AS n FROM orchestration_events WHERE command_id='settings-operation'`,
            [{ n: 1 }],
          );
        }).pipe(Effect.provide(runtime(file)));
      }),
    ),
);

it.effect(
  "composes final HostBindings only on admitted fixture ports and existing owner, never memory acknowledgement",
  () =>
    fixture((file) =>
      Effect.gen(function* () {
        const consumer = yield* makeExistingSettingsConsumer(options);
        const values = new Map(record.bindings.hosts.map((host) => [host.environmentId, false]));
        const bound = createHostBindings({
          publicHostMap: record.bindings,
          verifyPublicHostMap: async () => true,
          consumer,
          ports: record.bindings.hosts.map(({ environmentId }) => ({
            environmentId,
            verifyAuthenticated: async () => ({ environmentId, authenticated: true }),
            readContinuation: async () => values.get(environmentId)!,
            patchContinuation: async (value) => {
              values.set(environmentId, value);
              return value;
            },
          })),
        });
        const result = yield* Effect.promise(() =>
          bound.applyIntent("continueThreadsAfterServerUpdate", true),
        );
        assert.isTrue(result.effectiveMatch);
        assert.isAbove(result.receipt.sequence, 0);
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(yield* sql`SELECT COUNT(*) AS n FROM throughline_settings_record`, [
          { n: 1 },
        ]);
      }).pipe(Effect.provide(runtime(file))),
    ),
);

it.effect(
  "refuses a transient dispatch sequence without the corresponding durable receipt/event",
  () =>
    fixture((file) =>
      Effect.gen(function* () {
        const base = yield* EventSink.EventSinkV2;
        const consumer = yield* makeExistingSettingsConsumer(options).pipe(
          Effect.provideService(EventSink.EventSinkV2, {
            ...base,
            commitCommand: (input) =>
              Effect.succeed({
                committed: true,
                cancelledEffectCount: 0,
                storedEvents: [],
                receipt: {
                  commandId: input.commandId,
                  threadId: input.threadId,
                  commandType: input.commandType,
                  acceptedAt: input.acceptedAt,
                  resultSequence: 999,
                  status: "accepted",
                  error: null,
                },
              }),
          }),
        );
        const failure = yield* Effect.tryPromise({
          try: () => consumer.append(record, context),
          catch: (error) =>
            error instanceof UnconfirmedSettingsRecordError
              ? error
              : new UnconfirmedSettingsRecordError(record),
        }).pipe(Effect.flip);
        assert.instanceOf(failure, UnconfirmedSettingsRecordError);
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(yield* sql`SELECT COUNT(*) AS n FROM throughline_settings_record`, [
          { n: 0 },
        ]);
      }).pipe(Effect.provide(runtime(file))),
    ),
);

it.effect(
  "retains field-limited evidence after an already committed append failure without automatic retry",
  () =>
    fixture((file) =>
      Effect.gen(function* () {
        const base = yield* EventSink.EventSinkV2;
        let attempts = 0;
        const consumer = yield* makeExistingSettingsConsumer(options).pipe(
          Effect.provideService(EventSink.EventSinkV2, {
            ...base,
            commitCommand: (input) =>
              Effect.gen(function* () {
                attempts++;
                yield* base.commitCommand(input);
                return yield* new EventSink.EventSinkWriteError({
                  eventCount: input.events.length,
                  commandId: input.commandId,
                  cause: "fixture lost acknowledgement after commit",
                });
              }),
          }),
        );
        const failure = yield* Effect.tryPromise({
          try: () => consumer.append(record, context),
          catch: (error) =>
            error instanceof UnconfirmedSettingsRecordError
              ? error
              : new UnconfirmedSettingsRecordError(record),
        }).pipe(Effect.flip);
        assert.instanceOf(failure, UnconfirmedSettingsRecordError);
        assert.equal(attempts, 1);
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(yield* sql`SELECT COUNT(*) AS n FROM throughline_settings_record`, [
          { n: 1 },
        ]);
        assert.deepEqual(
          yield* sql`SELECT COUNT(*) AS n FROM orchestration_events WHERE command_id='settings-operation'`,
          [{ n: 1 }],
        );
      }).pipe(Effect.provide(runtime(file))),
    ),
);
