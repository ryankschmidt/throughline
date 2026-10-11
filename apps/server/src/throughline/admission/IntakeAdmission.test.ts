import { assert, it } from "@effect/vitest";
import { CommandId, ThreadId, MessageId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Receipts from "../../orchestration-v2/CommandReceiptStore.ts";
import * as Projections from "../../orchestration-v2/ProjectionStore.ts";
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import * as Launches from "../../orchestration-v2/ThreadLaunchService.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerConfig } from "../../config.ts";
import { CurrentAuthenticatedSender, CurrentSenderClaims } from "../identity/sender-stamp.ts";
import { restoreSender } from "../record/AbsurdRuntimeInProcess.ts";
import {
  decodeIntakeResult,
  dispatchCommand,
  intakeIdempotencyKey,
  runNativeIntake,
  runNativeIntakeTaskOutcome,
  CurrentSenderContextUnavailable,
  IntakeRejected,
  type IntakeCall,
} from "./IntakeAdmission.ts";

const call = {
  kind: "dispatch",
  input: {
    type: "message.dispatch",
    commandId: CommandId.make("command"),
    threadId: ThreadId.make("thread"),
    messageId: MessageId.make("message"),
    text: "text",
    attachments: [],
    createdBy: "user",
    creationSource: "web",
    dispatchMode: { type: "start_immediately" },
  },
} satisfies IntakeCall;
it("same command and content reuse the same durable task key; changed content remains a V2 conflict candidate", () => {
  assert.strictEqual(
    intakeIdempotencyKey(call),
    intakeIdempotencyKey({ ...call, input: { ...call.input } }),
  );
  assert.notStrictEqual(
    intakeIdempotencyKey(call),
    intakeIdempotencyKey({ ...call, input: { ...call.input, text: "different" } }),
  );
});
it.effect("an unmounted durable turn rail refuses before executing the native intake", () =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(dispatchCommand(call.input));
    assert.strictEqual(failure._tag, "TurnRailUnavailable");
    if (failure._tag === "TurnRailUnavailable") assert.isFalse(failure.accepted);
  }),
);
it.effect("accepts the real dispatch result shape and refuses a fabricated acknowledgement", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(
      yield* decodeIntakeResult("dispatch", { sequence: 1, storedEvents: [] }),
      { sequence: 1, storedEvents: [] },
    );
    assert.isTrue(
      Exit.isFailure(yield* Effect.exit(decodeIntakeResult("dispatch", { accepted: true }))),
    );
  }),
);

const sender = {
  publicAgentId: "trusted",
  generation: "generation",
  nativeKind: "app-session" as const,
  nativeId: "session",
};
const stores = Layer.mergeAll(EventStore.layer, Receipts.layer, Projections.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
);
// Known-bad transient acknowledgement: right shape, no durable receipt row.
const rejectionSink =
  process.env.THROUGHLINE_SENDER_BASELINE === "1"
    ? Layer.effect(
        EventSink.EventSinkV2,
        Effect.gen(function* () {
          const base = yield* EventSink.EventSinkV2;
          return {
            ...base,
            commitRejectedCommand: (input: Parameters<typeof base.commitRejectedCommand>[0]) =>
              Effect.succeed({
                commandId: input.commandId,
                threadId: input.threadId,
                commandType: input.commandType,
                acceptedAt: input.rejectedAt,
                resultSequence: 0,
                status: "rejected" as const,
                error: input.error,
              }),
          };
        }),
      ).pipe(Layer.provide(EventSink.layer))
    : EventSink.layer;
const rejectedRuntime = rejectionSink.pipe(
  Layer.provideMerge(stores),
  Layer.provideMerge(
    Layer.merge(
      Layer.mock(Threads.ThreadManagementService)({}),
      Layer.mock(Launches.ThreadLaunchService)({}),
    ),
  ),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "throughline-intake-rejection-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);
it.effect(
  "forged sender at durable ingress persists one rejected native receipt and writes zero events on replay",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient,
        receipts = yield* Receipts.CommandReceiptStoreV2;
      for (let attempt = 0; attempt < 2; attempt++) {
        const failure = yield* runNativeIntake(call).pipe(
          Effect.provideService(CurrentAuthenticatedSender, sender),
          Effect.provideService(CurrentSenderClaims, [{ field: "publicAgentId", value: "forged" }]),
          Effect.flip,
        );
        assert.equal(failure._tag, "IntakeRejected");
        if (failure._tag === "IntakeRejected") assert.equal(failure.receipt?.status, "rejected");
      }
      const stored = yield* receipts.getByCommandId(call.input.commandId);
      assert.isTrue(Option.isSome(stored));
      if (Option.isSome(stored)) {
        assert.equal(stored.value.status, "rejected");
        assert.equal(stored.value.threadId, call.input.threadId);
        assert.equal(stored.value.commandType, "message.dispatch");
        assert.include(stored.value.error!, "SenderIdentityMismatch");
      }
      assert.deepEqual(yield* sql`SELECT COUNT(*) AS n FROM orchestration_events`, [{ n: 0 }]);
    }).pipe(Effect.provide(rejectedRuntime)),
);
it.effect("matching authenticated claims proceed into the actual native intake helper", () =>
  Effect.gen(function* () {
    let calls = 0;
    const result = yield* runNativeIntake(call).pipe(
      Effect.provideService(CurrentAuthenticatedSender, sender),
      Effect.provideService(CurrentSenderClaims, [
        { field: "publicAgentId", value: sender.publicAgentId },
        { field: "generation", value: sender.generation },
      ]),
      Effect.provide(
        Layer.mock(Threads.ThreadManagementService)({
          dispatch: () =>
            Effect.sync(() => {
              calls++;
              return { sequence: 1, storedEvents: [] };
            }),
        }),
      ),
    );
    assert.equal(calls, 1);
    assert.deepEqual(result, { sequence: 1, storedEvents: [] });
  }).pipe(Effect.provide(rejectedRuntime)),
);
it.effect(
  "the registered task outcome completes on rejection and the client decoder restores its native rejected receipt",
  () =>
    Effect.gen(function* () {
      const outcome = yield* runNativeIntakeTaskOutcome(call).pipe(
        Effect.provideService(CurrentAuthenticatedSender, sender),
        Effect.provideService(CurrentSenderClaims, [
          { field: "generation", value: "forged-generation" },
        ]),
      );
      const result = yield* Effect.exit(decodeIntakeResult("dispatch", outcome));
      assert.isTrue(Exit.isFailure(result));
      if (Exit.isFailure(result)) {
        const refused = Cause.squash(result.cause);
        assert.isTrue(Schema.is(IntakeRejected)(refused));
        if (Schema.is(IntakeRejected)(refused)) {
          assert.equal(refused.receipt?.commandId, call.input.commandId);
          assert.equal(refused.receipt?.status, "rejected");
        }
      }
    }).pipe(Effect.provide(rejectedRuntime)),
);
it.effect("threadless launch refuses honestly without inventing a thread or a receipt", () =>
  Effect.gen(function* () {
    const launch = {
      kind: "launch",
      input: {
        commandId: CommandId.make("threadless-launch"),
        projectId: ProjectId.make("project"),
        title: "Fixture",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        createdBy: "user",
        creationSource: "web",
      },
    } satisfies IntakeCall;
    const refused = yield* runNativeIntake(launch).pipe(
      Effect.provideService(CurrentSenderContextUnavailable, true),
      Effect.flip,
    );
    assert.equal(refused._tag, "IntakeRejected");
    if (refused._tag === "IntakeRejected") assert.isNull(refused.receipt);
    assert.isTrue(
      Option.isNone(
        yield* (yield* Receipts.CommandReceiptStoreV2).getByCommandId(launch.input.commandId),
      ),
    );
  }).pipe(Effect.provide(rejectedRuntime)),
);
it.effect(
  "unrestorable serialized rail sender reaches the same rejected receipt path instead of throwing before ingress",
  () =>
    Effect.gen(function* () {
      const restored = yield* restoreSender({
        sender: { ...sender, publicAgentId: "" },
        claims: [],
      });
      assert.equal(restored._tag, "SenderContextUnavailable");
      const failure = yield* runNativeIntake({
        ...call,
        input: { ...call.input, commandId: CommandId.make("missing-sender") },
      }).pipe(Effect.provideService(CurrentSenderContextUnavailable, true), Effect.flip);
      assert.equal(failure._tag, "IntakeRejected");
      if (failure._tag === "IntakeRejected")
        assert.equal(failure.receipt?.error, "SenderContextUnavailable");
      assert.deepEqual(
        yield* (yield* SqlClient.SqlClient)`SELECT COUNT(*) AS n FROM orchestration_events`,
        [{ n: 0 }],
      );
    }).pipe(Effect.provide(rejectedRuntime)),
);
