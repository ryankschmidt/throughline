import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import {
  MessageId,
  ThreadId,
  TurnItemId,
  RunId,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import { buildThreadFeed } from "../../lib/threadActivity";

const threadId = ThreadId.make("public-a5-fixture");
function base(id: string, ordinal: number) {
  const timestamp = DateTime.makeUnsafe("2026-10-13T15:30:00.000Z");
  return {
    id: TurnItemId.make(id),
    threadId,
    runId: RunId.make("public-fixture-run"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: timestamp,
    completedAt: timestamp,
    updatedAt: timestamp,
  };
}
function projected(
  item: OrchestrationV2TurnItem,
  position: number,
): OrchestrationV2ProjectedTurnItem {
  return { position, visibility: "local", sourceThreadId: threadId, sourceItemId: item.id, item };
}
function rawItems(feed: ReturnType<typeof buildThreadFeed>) {
  return feed.flatMap((entry) =>
    entry.type === "activity-group"
      ? entry.activities.map((activity) => activity.projectedItem.item)
      : [],
  );
}

describe("mobile conversation hides internal runtime rows without deleting turn data", () => {
  it.each(["monitor", "background_task"] as const)(
    "omits internal %s notification cards",
    (kind) => {
      const item = {
        ...base("internal-work", 0),
        type: "notification",
        source: { kind },
        outcome: "cancelled",
        summary: "Re-arm the Android pairing watch stopped",
        detail: "Internal agent work, not a conversation message",
      } as OrchestrationV2TurnItem;
      const input = [projected(item, 0)];
      expect(rawItems(buildThreadFeed(input))).toEqual([]);
      expect(input[0]?.item).toBe(item);
    },
  );
  it("omits the raw Claude ui_status system row", () => {
    const item = {
      ...base("ui-status", 0),
      type: "system_notice",
      message: "Claude system message ui_status — plugin",
    } as OrchestrationV2TurnItem;
    expect(rawItems(buildThreadFeed([projected(item, 0)]))).toEqual([]);
  });
  it("keeps real tool work, ordinary system notices and conversation text mentioning ui_status", () => {
    const tool = {
      ...base("real-tool", 0),
      type: "dynamic_tool",
      toolName: "Read",
      title: "Read src/settings.ts",
      input: { file_path: "src/settings.ts" },
      output: "public result",
    } as OrchestrationV2TurnItem;
    const notice = {
      ...base("real-notice", 1),
      type: "system_notice",
      message: "Connection was restored",
    } as OrchestrationV2TurnItem;
    const user = {
      ...base("real-user", 2),
      type: "user_message",
      messageId: MessageId.make("fixture-user"),
      text: "Please fix Claude system message ui_status — plugin",
      attachments: [],
      createdBy: "user",
      creationSource: "mobile",
      inputIntent: "turn_start",
    } satisfies Extract<OrchestrationV2TurnItem, { type: "user_message" }>;
    const feed = buildThreadFeed([projected(tool, 0), projected(notice, 1), projected(user, 2)]);
    expect(rawItems(feed).map((item) => item.id)).toEqual([tool.id, notice.id]);
    expect(feed.some((entry) => entry.type === "message" && entry.message.text === user.text)).toBe(
      true,
    );
  });
});
