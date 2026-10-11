import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { MessageId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export class ExactMessageRewindError extends Schema.TaggedError<ExactMessageRewindError>()(
  "ExactMessageRewindError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason;
  }
}
export interface RewindRecords {
  readonly thread: Pick<
    OrchestrationV2ThreadProjection["thread"],
    "id" | "activeProviderThreadId" | "modelSelection"
  >;
  readonly messages: ReadonlyArray<
    Pick<OrchestrationV2ThreadProjection["messages"][number], "id" | "runId" | "role">
  >;
  readonly runs: ReadonlyArray<
    Pick<
      OrchestrationV2ThreadProjection["runs"][number],
      "id" | "ordinal" | "status" | "providerThreadId" | "userMessageId"
    >
  >;
  readonly providerThreads: ReadonlyArray<
    Pick<OrchestrationV2ThreadProjection["providerThreads"][number], "id" | "providerInstanceId">
  >;
  readonly providerTurns: ReadonlyArray<
    Pick<OrchestrationV2ThreadProjection["providerTurns"][number], "providerThreadId" | "status">
  >;
  readonly nodes: ReadonlyArray<
    Pick<OrchestrationV2ThreadProjection["nodes"][number], "kind" | "status">
  >;
}
export interface ExactMessageRewindInput {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
}
export function resolveExactMessageTarget(
  projection: RewindRecords,
  input: ExactMessageRewindInput,
) {
  if (projection.thread.id !== input.threadId)
    throw new ExactMessageRewindError({ reason: "wrong-thread" });
  const message = projection.messages.find((m) => m.id === input.messageId);
  if (message === undefined || message.role !== "user" || message.runId === null)
    throw new ExactMessageRewindError({ reason: "unknown-message" });
  const selectedRun = projection.runs.find((run) => run.id === message.runId);
  const providerThread = projection.providerThreads.find(
    (thread) => thread.id === projection.thread.activeProviderThreadId,
  );
  if (selectedRun === undefined || selectedRun.status === "rolled_back")
    throw new ExactMessageRewindError({ reason: "unknown-run" });
  if (
    providerThread === undefined ||
    selectedRun.providerThreadId !== providerThread.id ||
    providerThread.providerInstanceId !== projection.thread.modelSelection.instanceId
  )
    throw new ExactMessageRewindError({ reason: "active-provider-changed" });
  // Upstream hides whole rolled-back runs. An intra-run cut must not discard earlier messages.
  if (selectedRun.userMessageId !== message.id)
    throw new ExactMessageRewindError({ reason: "intra-run-trim-not-supported" });
  if (
    // Upstream ClaudeAdapterV2.isTerminalProviderTurn's four terminal states.
    // A waiting run can be idle-awaiting-checkpoint, not an active provider.
    projection.providerTurns.some(
      (turn) =>
        turn.providerThreadId === providerThread.id &&
        !["completed", "interrupted", "failed", "cancelled"].includes(turn.status),
    ) ||
    projection.nodes.some(
      (node) =>
        ["approval_request", "user_input_request"].includes(node.kind) && node.status === "waiting",
    )
  )
    throw new ExactMessageRewindError({ reason: "active-run" });
  const targetOrdinal = Math.max(
    0,
    ...projection.runs
      .filter((run) => run.ordinal < selectedRun.ordinal && run.status !== "rolled_back")
      .map((run) => run.ordinal),
  );
  const runsToRollback = projection.runs.filter(
    (run) => run.ordinal > targetOrdinal && run.status !== "rolled_back",
  );
  return { message, selectedRun, providerThread, targetOrdinal, runsToRollback };
}

export interface ExactMessageRewindAck {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly sequence: number;
}
export class ExactMessageRewindV2 extends Context.Service<
  ExactMessageRewindV2,
  {
    readonly execute: (
      input: ExactMessageRewindInput,
    ) => Effect.Effect<ExactMessageRewindAck, ExactMessageRewindError>;
    readonly recoverPendingCuts: Effect.Effect<void>;
    readonly recoveryInProgress: (threadId: ThreadId) => Effect.Effect<boolean>;
  }
>()("t3/throughline/rewind/ExactMessageRewindV2") {}
