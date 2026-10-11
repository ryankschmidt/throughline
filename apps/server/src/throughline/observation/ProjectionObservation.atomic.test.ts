import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  OrchestrationV2StoredEventJson,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
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
import { withAuthenticatedSender } from "../identity/sender-stamp.ts";
import * as ProjectionObservation from "./ProjectionObservation.ts";
import {
  assertDelayedCaptureAfterCut,
  assertCaptureThenCut,
} from "../rewind/testing/CheckpointHarness.ts";

const at = "2026-10-11T12:00:00.000Z";
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
  expectPublication = false,
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
