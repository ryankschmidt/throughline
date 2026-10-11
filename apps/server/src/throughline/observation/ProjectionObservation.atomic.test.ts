import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  CommandId,
  OrchestrationV2StoredEventJson,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectionMaintenance from "../../orchestration-v2/ProjectionMaintenance.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import type { layerMakeServer } from "../../server.ts";
import { withAuthenticatedSender } from "../identity/sender-stamp.ts";
import * as ProjectionObservation from "./ProjectionObservation.ts";
import {
  assertDelayedCaptureAfterCut,
  assertCaptureThenCut,
} from "../rewind/testing/CheckpointHarness.ts";

const at = "2026-10-11T12:00:00.000Z";
type ServerOutput =
  typeof layerMakeServer extends Layer.Layer<infer Output, infer _Error, infer _Input>
    ? Output
    : never;
const owningSqlOutput: SqlClient.SqlClient extends ServerOutput ? true : false = true;
const existingSinkOutput: EventSink.EventSinkV2 extends ServerOutput ? true : false = true;
const threadId = ThreadId.make("atomic-thread");
const sender = {
  publicAgentId: "public",
  generation: "generation",
  nativeKind: "app-session" as const,
  nativeId: "native-sender",
};
const event = (type: string, payload: unknown, suffix = type) =>
  Schema.decodeUnknownSync(OrchestrationV2StoredEventJson)({
    sequence: 1,
    commandId: null,
    event: { id: `atomic:${suffix}`, threadId, type, occurredAt: at, payload },
  }).event;
const thread = event("thread.created", {
  id: threadId,
  projectId: "project",
  title: "Atomic fixture",
  providerInstanceId: "claudeAgent",
  modelSelection: { instanceId: "claudeAgent", model: "requested" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
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
const metadata = [
  event("provider-thread.updated", {
    id: "provider-thread",
    driver: "claudeAgent",
    providerInstanceId: "claudeAgent",
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver: "claudeAgent", nativeId: "native-session", strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
  }),
  event("run.created", {
    id: "run",
    threadId,
    ordinal: 1,
    providerInstanceId: "claudeAgent",
    modelSelection: { instanceId: "claudeAgent", model: "requested" },
    providerThreadId: "provider-thread",
    userMessageId: "message",
    rootNodeId: null,
    activeAttemptId: null,
    status: "queued",
    requestedAt: at,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  }),
];
const message = (id = "message") =>
  event(
    "message.updated",
    {
      id,
      threadId,
      runId: "run",
      nodeId: null,
      role: "user",
      text: "fixture",
      attachments: [],
      streaming: false,
      createdBy: "user",
      creationSource: "web",
      createdAt: at,
      updatedAt: at,
    },
    id,
  );

function fixture<A, E, R>(
  body: Effect.Effect<A, E, R> | ((ready: Deferred.Deferred<void>) => Effect.Effect<A, E, R>),
  expectPublication: boolean | 0 = false,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "throughline-atomic-projection-",
      });
      // Baseline deliberately omits the wrapper: the same assertion must fail.
      const projection =
        process.env.THROUGHLINE_ATOMIC_BASELINE === "1"
          ? ProjectionStore.layer
          : ProjectionObservation.layer.pipe(Layer.provide(ProjectionStore.layer));
      const stores = Layer.mergeAll(EventStore.layer, projection).pipe(
        Layer.provideMerge(Sqlite.layerFromPath(path.join(directory, "state.sqlite"))),
      );
      const subscribed = yield* Deferred.make<void>();
      let messagePublications = 0;
      const publishWitness = Layer.effect(
        EventStore.EventStoreV2,
        Effect.gen(function* () {
          const base = yield* EventStore.EventStoreV2;
          const sql = yield* SqlClient.SqlClient;
          return EventStore.EventStoreV2.of({
            ...base,
            // EventSink.stream subscribes before calling latestSequence.
            latestSequence: (input) =>
              base
                .latestSequence(input)
                .pipe(Effect.tap(() => Deferred.succeed(subscribed, undefined))),
            publishCommitted: (events) =>
              Effect.gen(function* () {
                if (events.some((row) => "event" in row && row.event.type === "message.updated")) {
                  // Synchronous publication boundary, before base publication. A
                  // post-commit decorator cannot satisfy this witness retroactively.
                  messagePublications++;
                  const rows =
                    yield* sql`SELECT * FROM throughline_message_sender WHERE message_id='message'`;
                  assert.lengthOf(
                    rows,
                    1,
                    "sender side row must already exist when publication begins",
                  );
                }
                yield* base.publishCommitted(events);
              }).pipe(Effect.orDie),
          });
        }),
      ).pipe(Layer.provide(stores));
      const sink = EventSink.layer.pipe(Layer.provide(publishWitness), Layer.provideMerge(stores));
      const layer = Layer.mergeAll(sink, ProjectionMaintenance.layer.pipe(Layer.provide(stores)));
      return yield* Effect.gen(function* () {
        yield* (yield* EventSink.EventSinkV2).write({
          commandId: CommandId.make("seed"),
          events: [thread],
        });
        const result = yield* typeof body === "function" ? body(subscribed) : body;
        if (expectPublication === 0)
          assert.equal(messagePublications, 0, "refused write must publish zero messages");
        if (expectPublication)
          assert.equal(messagePublications, 1, "publication witness must actually fire");
        return result;
      }).pipe(Effect.provide(layer));
    }),
  ).pipe(Effect.provide(NodeServices.layer));
}

it.effect("real SQLite: sender row is visible at publication", () =>
  fixture(
    (subscribed) =>
      Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const sql = yield* SqlClient.SqlClient;
        const reader = yield* sink.stream({ threadId, eventType: "message.updated" }).pipe(
          Stream.mapEffect(
            () =>
              sql`SELECT sender_public_id,sender_generation FROM throughline_message_sender WHERE message_id='message'`,
          ),
          Stream.runHead,
          Effect.forkScoped,
        );
        yield* Deferred.await(subscribed);
        yield* withAuthenticatedSender(
          sink.write({ commandId: CommandId.make("good"), events: [...metadata, message()] }),
          sender,
        );
        const observed = yield* Fiber.join(reader);
        assert.equal(observed._tag, "Some");
        if (observed._tag === "Some")
          assert.deepEqual(observed.value, [
            { sender_public_id: "public", sender_generation: "generation" },
          ]);
        assert.deepEqual(
          yield* sql`SELECT sender_public_id,sender_generation FROM throughline_message_sender`,
          [{ sender_public_id: "public", sender_generation: "generation" }],
        );
      }),
    true,
  ),
);

it.effect(
  "real SQLite: CHECK-failing sender rolls event, projection and side rows back together",
  () =>
    fixture(
      Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        let errorTag: string | undefined;
        const failure = yield* Effect.exit(
          withAuthenticatedSender(
            sink.write({ commandId: CommandId.make("bad"), events: [...metadata, message()] }),
            { ...sender, publicAgentId: "", nativeId: "bad-native" },
          ).pipe(
            Effect.tapError((error) =>
              Effect.sync(() => {
                errorTag = error._tag;
              }),
            ),
          ),
        );
        assert.isTrue(Exit.isFailure(failure));
        assert.equal(errorTag, "EventSinkWriteError");
        const sql = yield* SqlClient.SqlClient;
        for (const table of [
          "orchestration_v2_projection_messages",
          "throughline_message_sender",
          "throughline_thread_identity",
          "throughline_run_observation",
        ]) {
          assert.deepEqual(
            yield* sql.unsafe(`SELECT COUNT(*) AS n FROM ${table}`),
            [{ n: 0 }],
            table,
          );
        }
        assert.deepEqual(
          yield* sql`SELECT COUNT(*) AS n FROM orchestration_events WHERE command_id='bad'`,
          [{ n: 0 }],
        );
        assert.deepEqual(
          yield* sql`SELECT COUNT(*) AS n FROM identity_alias WHERE native_id='bad-native'`,
          [{ n: 0 }],
        );
      }),
      0,
    ),
);

it.effect("real SQLite: stale run committed=false leaves side tables unchanged", () =>
  fixture(
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const result = yield* withAuthenticatedSender(
        sink.writeIfRunCurrent({
          threadId,
          runId: RunId.make("absent"),
          activeAttemptId: RunAttemptId.make("stale"),
          expectedStatus: "running",
          events: [...metadata, message()],
        }),
        sender,
      );
      assert.isFalse(result.committed);
      const sql = yield* SqlClient.SqlClient;
      for (const table of [
        "throughline_message_sender",
        "throughline_thread_identity",
        "throughline_run_observation",
      ]) {
        assert.deepEqual(
          yield* sql.unsafe(`SELECT COUNT(*) AS n FROM ${table}`),
          [{ n: 0 }],
          table,
        );
      }
    }),
  ),
);

it.effect(
  "real SQLite: projection rebuild re-derives identity/observation without manufacturing sender",
  () =>
    fixture(
      Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        yield* withAuthenticatedSender(
          sink.write({ commandId: CommandId.make("rebuild"), events: [...metadata, message()] }),
          sender,
        );
        const sql = yield* SqlClient.SqlClient;
        for (const table of [
          "throughline_message_sender",
          "throughline_thread_identity",
          "throughline_run_observation",
        ])
          yield* sql.unsafe(`DELETE FROM ${table}`);
        assert.isTrue(
          (yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild).valid,
        );
        assert.deepEqual(
          yield* sql`SELECT native_session_id,native_transcript_path FROM throughline_thread_identity`,
          [{ native_session_id: "native-session", native_transcript_path: null }],
        );
        assert.deepEqual(
          yield* sql`SELECT requested_model,answering_model FROM throughline_run_observation`,
          [{ requested_model: "requested", answering_model: null }],
        );
        assert.deepEqual(yield* sql`SELECT * FROM throughline_message_sender`, []);
      }),
    ),
);

it.effect(
  "real SQLite/Git: checkpoint cannot publish after an in-flight cut and capture-first becomes stale",
  () =>
    Effect.gen(function* () {
      yield* assertDelayedCaptureAfterCut();
      yield* assertCaptureThenCut();
    }),
);

// A separately run caller has no persistence service in its ambient context.
it.effect("real SQLite: sealed caller without ambient SqlClient still stamps transactionally", () =>
  fixture(
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      yield* Effect.promise(() =>
        Effect.runPromise(
          Effect.gen(function* () {
            assert.equal((yield* Effect.serviceOption(SqlClient.SqlClient))._tag, "None");
            yield* withAuthenticatedSender(
              sink.write({ commandId: CommandId.make("sealed"), events: [...metadata, message()] }),
              sender,
            );
          }),
        ),
      );
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(
        yield* sql`SELECT sender_public_id,sender_generation FROM throughline_message_sender WHERE message_id='message'`,
        [{ sender_public_id: "public", sender_generation: "generation" }],
      );
    }),
  ),
);

function isolatedClientControls(wrongClient: boolean, wrongVisibilityClient = false) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "throughline-sql-client-custody-",
      });
      const filename = path.join(directory, "state.sqlite");
      const ownerContext = yield* Layer.build(Sqlite.layerFromPath(filename));
      const owner = yield* SqlClient.SqlClient.pipe(Effect.provide(ownerContext));
      const readerContext = yield* Layer.build(NodeSqliteClient.layer({ filename }));
      const reader = yield* SqlClient.SqlClient.pipe(Effect.provide(readerContext));
      assert.notStrictEqual(
        owner,
        reader,
        "independent connections require distinct service instances",
      );
      let stockClient: SqlClient.SqlClient | undefined;
      const stock = Layer.effect(
        ProjectionStore.ProjectionStoreV2,
        Effect.gen(function* () {
          const base = yield* ProjectionStore.ProjectionStoreV2;
          stockClient = yield* SqlClient.SqlClient;
          return base;
        }),
      ).pipe(
        Layer.provide(ProjectionStore.layer),
        Layer.provide(Layer.succeed(SqlClient.SqlClient, owner)),
      );
      let insideWitnesses = 0;
      const observed = ProjectionObservation.layer.pipe(Layer.provide(stock));
      const guarded = Layer.effect(
        ProjectionStore.ProjectionStoreV2,
        Effect.gen(function* () {
          const base = yield* ProjectionStore.ProjectionStoreV2;
          const captured = yield* SqlClient.SqlClient;
          assert.strictEqual(
            captured,
            stockClient,
            wrongVisibilityClient
              ? "same client must see its in-transaction stamp"
              : "observed and stock stores must capture the same service object",
          );
          return ProjectionStore.ProjectionStoreV2.of({
            ...base,
            apply: (event) =>
              Effect.gen(function* () {
                yield* base.apply(event);
                if (event.type === "message.updated") {
                  const same = yield* (wrongVisibilityClient
                    ? reader
                    : captured)`SELECT COUNT(*) AS n FROM throughline_message_sender WHERE message_id='message'`;
                  const separate =
                    yield* reader`SELECT COUNT(*) AS n FROM throughline_message_sender WHERE message_id='message'`;
                  assert.deepEqual(
                    same,
                    [{ n: 1 }],
                    "same client must see its in-transaction stamp",
                  );
                  assert.deepEqual(
                    separate,
                    [{ n: 0 }],
                    "independent client must not see uncommitted stamp",
                  );
                  insideWitnesses++;
                }
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProjectionStore.ProjectionStoreApplyEventError({
                      eventType: event.type,
                      cause,
                    }),
                ),
              ),
          });
        }),
      ).pipe(
        Layer.provide(observed),
        Layer.provide(Layer.succeed(SqlClient.SqlClient, wrongClient ? reader : owner)),
      );
      const stores = Layer.mergeAll(EventStore.layer, guarded).pipe(
        Layer.provide(Layer.succeed(SqlClient.SqlClient, owner)),
      );
      const sinkLayer = EventSink.layer.pipe(
        Layer.provide(stores),
        Layer.provide(Layer.succeed(SqlClient.SqlClient, owner)),
      );
      const trial = Effect.gen(function* () {
        assert.equal((yield* Effect.serviceOption(SqlClient.SqlClient))._tag, "None");
        const sink = yield* EventSink.EventSinkV2;
        yield* sink.write({ commandId: CommandId.make("dual-seed"), events: [thread] });
        yield* withAuthenticatedSender(
          sink.write({ commandId: CommandId.make("dual-good"), events: [...metadata, message()] }),
          sender,
        );
        assert.equal(insideWitnesses, 1, "transaction visibility probe must actually fire");
        assert.deepEqual(
          yield* reader`SELECT COUNT(*) AS n FROM throughline_message_sender`,
          [{ n: 1 }],
          "independent reader sees stamp after sink returns",
        );
        const before = yield* reader`SELECT COUNT(*) AS n FROM orchestration_events`;
        const bad = yield* Effect.exit(
          withAuthenticatedSender(
            sink.write({ commandId: CommandId.make("dual-bad"), events: [message("bad-message")] }),
            { ...sender, publicAgentId: "", nativeId: "bad-identity" },
          ),
        );
        assert.isTrue(Exit.isFailure(bad));
        assert.deepEqual(yield* reader`SELECT COUNT(*) AS n FROM orchestration_events`, before);
        assert.deepEqual(
          yield* reader`SELECT COUNT(*) AS n FROM orchestration_v2_projection_messages WHERE message_id='bad-message'`,
          [{ n: 0 }],
        );
        assert.deepEqual(
          yield* reader`SELECT COUNT(*) AS n FROM throughline_message_sender WHERE message_id='bad-message'`,
          [{ n: 0 }],
        );
      }).pipe(Effect.provide(sinkLayer));
      if (wrongClient || wrongVisibilityClient) {
        const refused = yield* Effect.exit(trial);
        assert.isTrue(
          Exit.isFailure(refused),
          "deliberate second-client composition must fail the identity guard",
        );
        if (Exit.isFailure(refused))
          assert.include(
            Cause.pretty(refused.cause),
            wrongVisibilityClient
              ? "same client must see its in-transaction stamp"
              : "observed and stock stores must capture the same service object",
          );
        assert.equal(insideWitnesses, 0);
        assert.deepEqual(yield* reader`SELECT COUNT(*) AS n FROM orchestration_events`, [
          { n: wrongVisibilityClient ? 1 : 0 },
        ]);
      } else yield* trial;
    }),
  ).pipe(Effect.provide(NodeServices.layer));
}
it.effect(
  "real SQLite: one captured service retains transaction visibility and CHECK rollback with no ambient SQL",
  () => isolatedClientControls(false),
);
it.effect("real SQLite: deliberate second client refuses the stock-store identity guard", () =>
  isolatedClientControls(true),
);

it.effect(
  "real SQLite: deliberately probing through a second client fails the in-transaction visibility witness",
  () => isolatedClientControls(false, true),
);

it.effect("ApplyProbe defaults to undefined without a fixture context", () =>
  Effect.gen(function* () {
    assert.isTrue(owningSqlOutput);
    assert.isTrue(existingSinkOutput);
    assert.isUndefined(yield* ProjectionObservation.ApplyProbe);
  }),
);

it.effect("ApplyProbe reads the call-time reference after the sealed side stamp", () =>
  fixture(
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const owner = yield* SqlClient.SqlClient;
      let markers = 0;
      const probe: ProjectionObservation.ApplyProbeCallback = ({ event, client }) =>
        Effect.gen(function* () {
          if (event.type !== "message.updated") return;
          assert.strictEqual(client, owner);
          assert.deepEqual(
            yield* client`SELECT COUNT(*) AS n FROM throughline_message_sender WHERE message_id='message'`,
            [{ n: 1 }],
          );
          markers++;
        }).pipe(Effect.orDie);
      yield* Effect.promise(() =>
        Effect.runPromise(
          withAuthenticatedSender(
            sink.write({
              commandId: CommandId.make("probe-good"),
              events: [...metadata, message()],
            }),
            sender,
          ).pipe(Effect.provideService(ProjectionObservation.ApplyProbe, probe)),
        ),
      );
      assert.equal(markers, 1, "probe must run once after the message stamp");
    }),
  ),
);

it.effect("ApplyProbe failure rolls back the fixture transaction and publishes nothing", () =>
  fixture(
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const probe: ProjectionObservation.ApplyProbeCallback = ({ event }) =>
        event.type === "message.updated" ? Effect.die("Fixture ApplyProbe refusal") : Effect.void;
      const refused = yield* Effect.exit(
        withAuthenticatedSender(
          sink.write({ commandId: CommandId.make("probe-bad"), events: [...metadata, message()] }),
          sender,
        ).pipe(Effect.provideService(ProjectionObservation.ApplyProbe, probe)),
      );
      assert.isTrue(Exit.isFailure(refused));
      if (Exit.isFailure(refused))
        assert.include(Cause.pretty(refused.cause), "Fixture ApplyProbe refusal");
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(
        yield* sql`SELECT COUNT(*) AS n FROM orchestration_events WHERE command_id='probe-bad'`,
        [{ n: 0 }],
      );
      for (const table of [
        "orchestration_v2_projection_messages",
        "throughline_message_sender",
        "throughline_thread_identity",
        "throughline_run_observation",
      ])
        assert.deepEqual(yield* sql.unsafe(`SELECT COUNT(*) AS n FROM ${table}`), [{ n: 0 }]);
    }),
    0,
  ),
);
