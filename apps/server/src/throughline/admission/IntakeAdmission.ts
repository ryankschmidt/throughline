// Native Node APIs bridge the existing task transport and its file/stream contracts.
// @effect-diagnostics nodeBuiltinImport:off
import type { AbsurdRuntimeHandle, ThreadRunParams } from "@t3tools/absurd-runtime";
import {
  OrchestrationV2Command,
  OrchestrationV2StoredEventJson,
  OrchestrationV2ThreadProjectionJson,
  OrchestrationV2ConversationMessageJson,
  OrchestrationV2RunJson,
  OrchestrationV2TurnItemJson,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { createHash } from "node:crypto";
import * as NativeIntake from "../../orchestration-v2/ThreadMessageIntake.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as DateTime from "effect/DateTime";
import {
  CurrentAuthenticatedSender,
  CurrentSenderClaims,
  assertSenderClaims,
} from "../identity/sender-stamp.ts";
import {
  computeRuntimeReadiness,
  readinessBlockingChecks,
  TURN_RAIL_REQUIRED_READINESS_CHECKS,
} from "../record/runtimeReadiness.ts";

export const V2_INTAKE_TASK = "throughline.v2.intake";
export const CurrentSenderContextUnavailable = Context.Reference<boolean>(
  "t3/throughline/admission/SenderContextUnavailable",
  { defaultValue: () => false },
);
export class IntakeRejected extends Schema.TaggedError<IntakeRejected>()("IntakeRejected", {
  reason: Schema.Literals(["SenderIdentityMismatch", "SenderContextUnavailable"]),
  receipt: Schema.NullOr(ReceiptStore.CommandReceiptV2),
}) {
  override get message() {
    return `Durable intake rejected: ${this.reason}.`;
  }
}
export const IntakeRejectedJson = Schema.toCodecJson(IntakeRejected);
export type ThreadRunSenderContext = NonNullable<ThreadRunParams["trustedSenderContext"]>;
export type IntakeCall =
  | { kind: "dispatch"; input: Parameters<typeof NativeIntake.dispatchCommand>[0] }
  | { kind: "launch"; input: Parameters<typeof NativeIntake.launchThread>[0] }
  | { kind: "send"; input: Parameters<typeof NativeIntake.sendToThread>[0] };
export type IntakeResult<Call extends IntakeCall> = Call extends { kind: "dispatch" }
  ? Effect.Success<ReturnType<typeof NativeIntake.dispatchCommand>>
  : Call extends { kind: "launch" }
    ? Effect.Success<ReturnType<typeof NativeIntake.launchThread>>
    : Effect.Success<ReturnType<typeof NativeIntake.sendToThread>>;
export type IntakeRequirements =
  | Effect.Services<ReturnType<typeof NativeIntake.dispatchCommand>>
  | Effect.Services<ReturnType<typeof NativeIntake.launchThread>>
  | Effect.Services<ReturnType<typeof NativeIntake.sendToThread>>
  | EventSink.EventSinkV2;

const dispatchCodec = Schema.Struct({
  sequence: Schema.Number,
  storedEvents: Schema.Array(OrchestrationV2StoredEventJson),
});
const launchCodec = Schema.Struct({
  threadId: ThreadId,
  projection: OrchestrationV2ThreadProjectionJson,
  resumed: Schema.Boolean,
});
const projection = OrchestrationV2ThreadProjectionJson.fields;
const sendCodec = Schema.Struct({
  dispatch: dispatchCodec,
  projection: Schema.Struct({
    thread: projection.thread,
    runs: projection.runs,
    messages: projection.messages,
    turnItems: projection.turnItems,
  }),
  message: OrchestrationV2ConversationMessageJson,
  run: OrchestrationV2RunJson,
  turnItem: Schema.NullOr(OrchestrationV2TurnItemJson),
  delivery: Schema.Literals(["started", "queued", "steered", "restarted"]),
});

export class TurnRailUnavailable extends Schema.TaggedError<TurnRailUnavailable>()(
  "TurnRailUnavailable",
  {
    message: Schema.String,
    accepted: Schema.Boolean,
  },
) {}

export class DurableIntake extends Context.Service<
  DurableIntake,
  {
    readonly runtime: AbsurdRuntimeHandle;
  }
>()("t3/throughline/admission/IntakeAdmission/DurableIntake") {}

/** Includes content, so a reused command id with changed input still reaches V2's conflict check. */
export function intakeIdempotencyKey(call: IntakeCall): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sort(item)]),
    );
  };
  const canonical = JSON.stringify(sort(JSON.parse(JSON.stringify(call))));
  return `throughline:v2:${call.kind}:${call.input.commandId}:${createHash("sha256").update(canonical).digest("hex")}`;
}

export const runNativeIntake = (call: IntakeCall) =>
  Effect.gen(function* () {
    const sender = yield* CurrentAuthenticatedSender,
      claims = yield* CurrentSenderClaims;
    const unavailable = yield* CurrentSenderContextUnavailable;
    const validated = yield* Effect.exit(assertSenderClaims(sender, claims));
    if (unavailable || validated._tag === "Failure") {
      const reason = unavailable ? "SenderContextUnavailable" : "SenderIdentityMismatch";
      const commandId = call.input.commandId,
        threadId = "threadId" in call.input ? call.input.threadId : undefined;
      const receipt =
        commandId === undefined || threadId === undefined
          ? null
          : yield* (yield* EventSink.EventSinkV2).commitRejectedCommand({
              commandId,
              threadId,
              commandType:
                call.kind === "dispatch"
                  ? call.input.type
                  : call.kind === "launch"
                    ? "thread.launch"
                    : "thread.send",
              rejectedAt: yield* DateTime.now,
              error: unavailable
                ? "SenderContextUnavailable"
                : "SenderIdentityMismatch: Authenticated sender claim mismatch.",
            });
      return yield* new IntakeRejected({ reason, receipt });
    }
    switch (call.kind) {
      case "dispatch": {
        const command = yield* Schema.decodeUnknownEffect(OrchestrationV2Command)(call.input);
        const result = yield* NativeIntake.dispatchCommand(command);
        return yield* Schema.encodeUnknownEffect(dispatchCodec)(result);
      }
      case "launch": {
        const result = yield* NativeIntake.launchThread(call.input);
        return yield* Schema.encodeUnknownEffect(launchCodec)(result);
      }
      case "send": {
        const result = yield* NativeIntake.sendToThread(call.input);
        return yield* Schema.encodeUnknownEffect(sendCodec)(result);
      }
    }
  });

/** Registered V2 task returns a terminal refusal as data so Absurd never retries it. */
export const runNativeIntakeTaskOutcome = (call: IntakeCall) =>
  runNativeIntake(call).pipe(
    Effect.catchTags({
      IntakeRejected: (failure) => Schema.encodeEffect(IntakeRejectedJson)(failure),
    }),
  );

export const decodeIntakeResult = (
  kind: IntakeCall["kind"],
  value: unknown,
): Effect.Effect<unknown, Schema.SchemaError | IntakeRejected> => {
  if (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    value._tag === "IntakeRejected"
  )
    return Schema.decodeUnknownEffect(IntakeRejectedJson)(value).pipe(Effect.flatMap(Effect.fail));
  switch (kind) {
    case "dispatch":
      return Schema.decodeUnknownEffect(dispatchCodec)(value);
    case "launch":
      return Schema.decodeUnknownEffect(launchCodec)(value);
    case "send":
      return Schema.decodeUnknownEffect(sendCodec)(value);
  }
};

const submit = <Call extends IntakeCall>(call: Call) =>
  Effect.gen(function* () {
    const service = yield* Effect.serviceOption(DurableIntake);
    if (service._tag === "None")
      return yield* new TurnRailUnavailable({
        message: "turn rail unavailable: the server-owned durable intake is not mounted",
        accepted: false,
      });
    const runtime = service.value.runtime;
    const reachable = yield* Effect.tryPromise(() => runtime.app.listQueues()).pipe(
      Effect.map((queues) => queues.includes(runtime.queueName)),
      Effect.orElseSucceed(() => false),
      Effect.timeoutOption("3 seconds"),
      Effect.map((value) => Option.getOrElse(value, () => false)),
    );
    const readiness = yield* Effect.promise(() =>
      computeRuntimeReadiness({
        absurdRuntime: Option.some(runtime),
        probeQueueReachable: async () => reachable,
        sessionBoundaryState: async () => "unknown",
      }),
    );
    const refused = readinessBlockingChecks(readiness, TURN_RAIL_REQUIRED_READINESS_CHECKS);
    if (refused.length > 0)
      return yield* new TurnRailUnavailable({
        message: `turn rail not ready: ${refused.join(", ")}`,
        accepted: false,
      });
    const sender = yield* CurrentAuthenticatedSender;
    const claims = yield* CurrentSenderClaims;
    const trustedSenderContext: ThreadRunSenderContext | undefined =
      sender === undefined ? undefined : { sender, claims };
    const spawned = yield* Effect.tryPromise({
      try: () =>
        runtime.app.spawn(
          V2_INTAKE_TASK,
          { call, ...(trustedSenderContext ? { trustedSenderContext } : {}) },
          { queue: runtime.queueName, idempotencyKey: intakeIdempotencyKey(call) },
        ),
      catch: () =>
        new TurnRailUnavailable({
          message: "turn rail unavailable: durable enqueue failed",
          accepted: false,
        }),
    });
    const outcome = yield* Effect.tryPromise({
      try: () =>
        runtime.app.awaitTaskResult(spawned.taskID, { queue: runtime.queueName, timeout: 30 }),
      catch: () =>
        new TurnRailUnavailable({
          message:
            "turn durably accepted; its acknowledgement is not available yet. Retry the same command id, not a new send.",
          accepted: true,
        }),
    });
    if (outcome.state !== "completed")
      return yield* new TurnRailUnavailable({
        message: `durable intake did not complete: ${outcome.state}`,
        accepted: true,
      });
    const result = yield* decodeIntakeResult(call.kind, outcome.result).pipe(
      Effect.mapError((cause) =>
        cause._tag === "IntakeRejected"
          ? cause
          : new TurnRailUnavailable({
              message: "durable intake result did not match its published V2 contract",
              accepted: true,
            }),
      ),
    );
    return result as IntakeResult<Call>;
  });

/** Same wire contract as upstream; only operations starting a message enter the existing rail. */
type NativeCommand = Parameters<typeof NativeIntake.dispatchCommand>[0];
type DispatchResult = Effect.Success<ReturnType<typeof NativeIntake.dispatchCommand>>;
type DispatchFailure =
  | Effect.Error<ReturnType<typeof NativeIntake.dispatchCommand>>
  | TurnRailUnavailable
  | IntakeRejected;
type DispatchRequirements = Effect.Services<ReturnType<typeof NativeIntake.dispatchCommand>>;
export function dispatchCommand(
  input: Extract<NativeCommand, { type: "message.dispatch" }>,
): Effect.Effect<DispatchResult, TurnRailUnavailable | IntakeRejected>;
export function dispatchCommand(
  input: NativeCommand,
): Effect.Effect<DispatchResult, DispatchFailure, DispatchRequirements>;
export function dispatchCommand(
  input: NativeCommand,
): Effect.Effect<DispatchResult, DispatchFailure, DispatchRequirements> {
  return Effect.gen(function* () {
    if (input.type === "message.dispatch") return yield* submit({ kind: "dispatch", input });
    return yield* NativeIntake.dispatchCommand(input);
  });
}
export const launchThread = (
  input: Parameters<typeof NativeIntake.launchThread>[0],
): Effect.Effect<
  Effect.Success<ReturnType<typeof NativeIntake.launchThread>>,
  Effect.Error<ReturnType<typeof NativeIntake.launchThread>> | TurnRailUnavailable | IntakeRejected,
  Effect.Services<ReturnType<typeof NativeIntake.launchThread>>
> =>
  input.initialMessage === undefined
    ? NativeIntake.launchThread(input)
    : submit({ kind: "launch", input });
export const sendToThread = (input: Parameters<typeof NativeIntake.sendToThread>[0]) =>
  submit({ kind: "send", input });
