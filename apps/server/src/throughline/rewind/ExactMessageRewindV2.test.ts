import { describe, expect, it } from "vite-plus/test";
import { MessageId, ProviderThreadId, RunId } from "@t3tools/contracts";
import { v2Projection } from "../../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import { resolveExactMessageTarget, type RewindRecords } from "./ExactMessageRewindV2.ts";

const messageId = MessageId.make("selected");
const providerThreadId = ProviderThreadId.make("provider-thread");
function run(id: string, ordinal: number): RewindRecords["runs"][number] {
  return {
    id: RunId.make(id),
    ordinal,
    status: "completed",
    providerThreadId,
    userMessageId: MessageId.make(id === "selected-run" ? "selected" : id),
  };
}
function message(id: string, runId: RunId): RewindRecords["messages"][number] {
  return { id: MessageId.make(id), runId, role: "user" };
}
function records(): RewindRecords {
  const previous = run("earlier-without-message", 2);
  const selected = run("selected-run", 3);
  return {
    thread: { ...v2Projection.thread, activeProviderThreadId: providerThreadId },
    runs: [run("first", 1), previous, selected],
    messages: [message("earlier", RunId.make("first")), message("selected", selected.id)],
    providerThreads: [
      { id: providerThreadId, providerInstanceId: v2Projection.thread.modelSelection.instanceId },
    ],
    providerTurns: [],
    nodes: [],
  };
}
describe("exact-message V2 target selection", () => {
  it("keeps work from message-less turns recorded before the rewind boundary", () => {
    const result = resolveExactMessageTarget(records(), {
      threadId: v2Projection.thread.id,
      messageId,
    });
    expect(result.targetOrdinal).toBe(2);
    expect(result.runsToRollback.map((run) => run.id)).toEqual(["selected-run"]);
  });
  it("retains explicit earlier messages without file checkpoints", () => {
    const projection = records();
    const result = resolveExactMessageTarget(projection, {
      threadId: projection.thread.id,
      messageId,
    });
    expect(
      projection.messages
        .filter((m) => !result.runsToRollback.some((r) => r.id === m.runId))
        .map((m) => m.id),
    ).toEqual(["earlier"]);
  });
  it("refuses an unknown native message without forking or restarting", () => {
    expect(() =>
      resolveExactMessageTarget(records(), {
        threadId: v2Projection.thread.id,
        messageId: MessageId.make("unknown"),
      }),
    ).toThrow();
  });
  it("carries an intra-run rewind as refusal and loses no message", () => {
    const base = records();
    const projection = {
      ...base,
      messages: [
        ...base.messages.map((message) => ({ ...message, text: message.id, attachments: [] })),
        {
          id: MessageId.make("steer"),
          runId: RunId.make("selected-run"),
          role: "user" as const,
          text: "later user message in the same run",
          attachments: [],
        },
      ],
    };
    const before = JSON.stringify(projection);
    expect(() =>
      resolveExactMessageTarget(projection, {
        threadId: projection.thread.id,
        messageId: MessageId.make("steer"),
      }),
    ).toThrow("intra-run-trim-not-supported");
    expect(JSON.stringify(projection)).toBe(before);
  });
  it("admits a waiting checkpoint run whose active provider turn is terminal", () => {
    const projection = records();
    const current = {
      ...projection,
      runs: projection.runs.map((run) => ({ ...run, status: "waiting" as const })),
      providerTurns: [{ providerThreadId, status: "completed" as const }],
    };
    expect(
      resolveExactMessageTarget(current, { threadId: current.thread.id, messageId }).targetOrdinal,
    ).toBe(2);
  });
  it("refuses a non-terminal active provider turn even when its run is completed", () => {
    const projection = {
      ...records(),
      providerTurns: [{ providerThreadId, status: "running" as const }],
    };
    expect(() =>
      resolveExactMessageTarget(projection, { threadId: projection.thread.id, messageId }),
    ).toThrow("active-run");
  });
  it.each(["approval_request", "user_input_request"] as const)(
    "refuses a waiting %s node",
    (kind) => {
      const projection = { ...records(), nodes: [{ kind, status: "waiting" as const }] };
      expect(() =>
        resolveExactMessageTarget(projection, { threadId: projection.thread.id, messageId }),
      ).toThrow("active-run");
    },
  );
});
