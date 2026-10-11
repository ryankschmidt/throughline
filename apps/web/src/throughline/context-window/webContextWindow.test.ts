import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import {
  deriveLatestContextWindowSnapshot,
  formatContextWindowTokens,
} from "../../lib/contextWindow";

describe("web context window on the upstream v2 reader", () => {
  it("prefers the provider's current live usage and retains the meter percentages", () => {
    expect(
      deriveLatestContextWindowSnapshot([], {
        usedTokens: 25_000,
        maxTokens: 100_000,
        inputTokens: 24_000,
        updatedAt: "2026-10-10T23:00:00.000Z",
      }),
    ).toMatchObject({
      usedTokens: 25_000,
      remainingTokens: 75_000,
      usedPercentage: 25,
      remainingPercentage: 75,
      inputTokens: 24_000,
    });
  });

  it("keeps an absent ceiling unknown and returns no invented usage when the projection is empty", () => {
    expect(
      deriveLatestContextWindowSnapshot([], {
        usedTokens: 50,
        updatedAt: "2026-10-10T23:00:00.000Z",
      }),
    ).toMatchObject({ maxTokens: null, usedPercentage: null, remainingTokens: null });
    expect(deriveLatestContextWindowSnapshot([])).toBeNull();
  });

  it("uses persisted provider usage after reload rather than a web-only activity list", () => {
    const providerThread = {
      contextUsage: { usedTokens: 40_000, maxTokens: 100_000, compactsAutomatically: true },
      updatedAt: DateTime.makeUnsafe("2026-10-10T23:00:00.000Z"),
    } as Parameters<typeof deriveLatestContextWindowSnapshot>[2];
    expect(deriveLatestContextWindowSnapshot([], null, providerThread)).toMatchObject({
      usedTokens: 40_000,
      remainingTokens: 60_000,
      usedPercentage: 40,
      updatedAt: "2026-10-10T23:00:00.000Z",
    });
  });

  it("keeps token formatting shared with the visible meter", () => {
    expect(formatContextWindowTokens(1_500)).toBe("1.5k");
    expect(formatContextWindowTokens(1_000_000)).toBe("1m");
  });
});
