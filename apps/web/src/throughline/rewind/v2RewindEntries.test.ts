import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import {
  buildV2RewindEntries,
  checkpointRequestForEntry,
  type V2RewindProjection,
} from "./v2RewindEntries";

function projection(overrides: Record<string, unknown> = {}): V2RewindProjection {
  const at = DateTime.makeUnsafe("2026-10-10T23:00:00.000Z");
  // This fixture exercises the adapter's field reads, not the wire decoder.
  return {
    messages: [
      {
        id: "message-2",
        role: "user",
        text: "recognizable second prompt",
        runId: "run-2",
        createdAt: at,
      },
    ],
    runs: [
      {
        id: "run-2",
        ordinal: 2,
        userMessageId: "message-2",
        providerThreadId: "provider-thread",
        status: "completed",
      },
    ],
    checkpointScopes: [{ id: "scope", kind: "root_run", providerThreadId: "provider-thread" }],
    checkpoints: [
      {
        id: "checkpoint-1",
        scopeId: "scope",
        status: "ready",
        ordinalWithinScope: 1,
        appRunOrdinal: 1,
      },
    ],
    ...overrides,
  } as unknown as V2RewindProjection;
}

describe("v2 rewind menu boundary", () => {
  it("keeps recognizable prompt text and dispatches an explicit ready checkpoint with files unchanged", () => {
    const entry = buildV2RewindEntries(projection())[0]!;
    expect(entry.text).toBe("recognizable second prompt");
    expect(entry.unavailableReason).toBeNull();
    expect(checkpointRequestForEntry(entry)).toEqual({
      checkpointId: "checkpoint-1",
      scopeId: "scope",
      restoreFiles: false,
    });
    expect(checkpointRequestForEntry(entry)).not.toHaveProperty("turnCount");
  });

  it("requires explicit file restoration", () => {
    expect(
      checkpointRequestForEntry(buildV2RewindEntries(projection())[0]!, true).restoreFiles,
    ).toBe(true);
  });

  it("keeps no-checkpoint messages visible but refuses rather than invent a native boundary", () => {
    const entry = buildV2RewindEntries(projection({ checkpoints: [] }))[0]!;
    expect(entry.text).toBe("recognizable second prompt");
    expect(entry.unavailableReason).toContain("not supported");
    expect(() => checkpointRequestForEntry(entry)).toThrow("not supported");
  });

  it("does not map a steer within a run to that run's checkpoint", () => {
    const entry = buildV2RewindEntries(
      projection({
        runs: [
          {
            id: "run-2",
            ordinal: 2,
            userMessageId: "earlier-message",
            providerThreadId: "provider-thread",
            status: "completed",
          },
        ],
      }),
    )[0]!;
    expect(entry.checkpointId).toBeNull();
    expect(() => checkpointRequestForEntry(entry)).toThrow();
  });

  it("does not take a ready checkpoint from another provider scope", () => {
    const entry = buildV2RewindEntries(
      projection({
        checkpointScopes: [
          { id: "scope", kind: "root_run", providerThreadId: "another-provider-thread" },
        ],
      }),
    )[0]!;
    expect(entry.checkpointId).toBeNull();
  });

  it("does not use a stale checkpoint or render a rolled-back run as a new target", () => {
    expect(
      buildV2RewindEntries(
        projection({
          checkpoints: [
            {
              id: "checkpoint-1",
              scopeId: "scope",
              status: "stale",
              ordinalWithinScope: 1,
              appRunOrdinal: 1,
            },
          ],
        }),
      )[0]!.checkpointId,
    ).toBeNull();
    expect(
      buildV2RewindEntries(
        projection({
          runs: [
            {
              id: "run-2",
              ordinal: 2,
              userMessageId: "message-2",
              providerThreadId: "provider-thread",
              status: "rolled_back",
            },
          ],
        }),
      ),
    ).toEqual([]);
  });
});
