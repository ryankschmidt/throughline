import { describe, expect, it } from "vite-plus/test";
import stamp from "../ThroughLine-Release-Stamp.json" with { type: "json" };
import { readReleaseStamp, releaseBuildIdentity } from "../src/index.ts";

const releaseFixture = { ...stamp, stamped_by: "throughline-ship@0.4.26" };
const read = (overrides: Record<string, unknown> = {}) =>
  readReleaseStamp(() => JSON.stringify({ ...releaseFixture, ...overrides }));
describe("release stamp validation boundary", () => {
  it("reads the fixed file and derives a monotonic stable-release counter", () => {
    let pathname = "";
    const parsed = readReleaseStamp((file) => {
      pathname = file.pathname;
      return JSON.stringify(releaseFixture);
    });
    expect(pathname.endsWith("/packages/throughline-release/ThroughLine-Release-Stamp.json")).toBe(
      true,
    );
    expect(parsed.version).toBe("0.0.56");
    expect(releaseBuildIdentity(parsed)).toEqual({ iosBuildNumber: "56", androidVersionCode: 56 });
    expect(releaseBuildIdentity({ version: "0.1.0" }).androidVersionCode).toBeGreaterThan(999);
  });
  it.each([
    ["invalid calendar day", { stamped_at: "2026-02-31T12:00:00Z" }],
    ["timestamp without UTC Z", { stamped_at: "2026-10-13T12:00:00+00:00" }],
    ["null commit", { commit: "0".repeat(40) }],
    ["off-line cut label", { cut_from: "branch" }],
    ["placeholder version", { version: "0.0.0" }],
    ["counter overflow", { version: "2101.0.0" }],
    ["counter collision", { version: "0.1000.0" }],
    ["missing writer", { stamped_by: "" }],
    ["extra authored readiness", { status: "ready" }],
    ["unknown platform", { platforms: [...stamp.platforms, "windows"] }],
    ["duplicate platform", { platforms: [...stamp.platforms, "mac"] }],
    ["deferred/selected overlap", { platforms: [...stamp.platforms, "rpi"] }],
    ["missing platform disposition", { platforms: stamp.platforms.filter((p) => p !== "mac") }],
  ] as const)("refuses %s", (_name, overrides) =>
    expect(() => read(overrides)).toThrow("RELEASE_STAMP"),
  );
  it("missing input refuses without copying the supplied error body", () => {
    expect(() =>
      readReleaseStamp(() => {
        throw new Error("DO_NOT_COPY_RAW_INPUT");
      }),
    ).toThrow("RELEASE_STAMP_MISSING_OR_MALFORMED");
  });
});
