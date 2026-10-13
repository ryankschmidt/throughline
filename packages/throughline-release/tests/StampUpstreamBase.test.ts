import { describe, expect, it } from "vite-plus/test";
import developmentStamp from "../ThroughLine-Release-Stamp.json" with { type: "json" };
import { readReleaseStamp } from "../src/index.ts";

const upstream = "5cbe82a87006a7ee472f0f9c9fce5d5f24caa795";
const v2 = {
  ...developmentStamp,
  schema: "throughline.release-stamp.v2",
  upstream_base_commit: upstream,
  stamped_by: "throughline-ship@0.4.26",
};

describe("strict v2 upstream identity reader", () => {
  it("retains the required upstream base without claiming cut or ancestry custody", () => {
    expect(readReleaseStamp(() => JSON.stringify(v2))).toMatchObject({
      schema: "throughline.release-stamp.v2",
      upstream_base_commit: upstream,
    });
  });

  it("refuses a v1 stamp rather than supplying an upstream default", () => {
    const { upstream_base_commit: _base, ...old } = v2;
    expect(() =>
      readReleaseStamp(() => JSON.stringify({ ...old, schema: "throughline.release-stamp.v1" })),
    ).toThrow("RELEASE_STAMP");
  });

  it.each([
    ["missing", undefined],
    ["zero", "0".repeat(40)],
    ["short", "a".repeat(39)],
    ["non-hex", "g".repeat(40)],
    ["null", null],
    ["non-string", 42],
  ] as const)("refuses %s upstream base", (_name, value) => {
    expect(() =>
      readReleaseStamp(() => JSON.stringify({ ...v2, upstream_base_commit: value })),
    ).toThrow("RELEASE_STAMP");
  });
});
