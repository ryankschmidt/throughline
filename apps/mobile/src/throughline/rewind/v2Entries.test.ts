import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { buildV2RewindEntries } from "./v2Entries";

const at = DateTime.makeUnsafe("2026-10-10T00:00:00Z");
// Partial public-projection fixtures exercise presentation; contracts own full wire decoding.
const projection = (inputIntent = "turn_start", checkpoints: unknown[] = []) =>
  ({
    messages: [],
    checkpoints,
    visibleTurnItems: [
      {
        sourceThreadId: "recorded-parent",
        item: {
          type: "user_message",
          messageId: "exact-message",
          runId: "recorded-run",
          text: "The original prompt\nwith its second line",
          attachments: [],
          inputIntent,
          startedAt: at,
          updatedAt: at,
        },
      },
    ],
  }) as unknown as OrchestrationV2ThreadProjection;

describe("V2 rewind prompt selection", () => {
  it("keeps exact inherited prompt identity even with zero file checkpoints", () => {
    const [entry] = buildV2RewindEntries(projection());
    expect(entry?.id).toBe("exact-message");
    expect(entry?.text).toBe("The original prompt\nwith its second line");
    expect(entry?.fileCheckpoint).toBeNull();
    expect(entry).not.toHaveProperty("turnCount");
  });

  it("offers file restoration only through a recorded ready parent checkpoint", () => {
    const checkpoints = [
      { id: "before", scopeId: "recorded-scope", status: "ready", runId: null },
      {
        id: "after",
        scopeId: "recorded-scope",
        status: "ready",
        runId: "recorded-run",
        parentCheckpointId: "before",
      },
    ];
    expect(buildV2RewindEntries(projection("turn_start", checkpoints))[0]?.fileCheckpoint).toEqual({
      checkpointId: "before",
      scopeId: "recorded-scope",
    });
    expect(buildV2RewindEntries(projection("steer", checkpoints))[0]?.fileCheckpoint).toBeNull();
  });

  it("refuses a stale file target without hiding the conversation prompt", () => {
    const checkpoints = [
      { id: "before", scopeId: "recorded-scope", status: "stale", runId: null },
      {
        id: "after",
        scopeId: "recorded-scope",
        status: "ready",
        runId: "recorded-run",
        parentCheckpointId: "before",
      },
    ];
    const [entry] = buildV2RewindEntries(projection("turn_start", checkpoints));
    expect(entry?.fileCheckpoint).toBeNull();
    expect(entry?.id).toBe("exact-message");
  });

  it("returns no invented prompt while projection data is absent", () => {
    expect(buildV2RewindEntries(null)).toEqual([]);
  });
});
