import { describe, expect, it } from "vite-plus/test";
import committedStamp from "../ThroughLine-Release-Stamp.json" with { type: "json" };
import { readReleaseStamp } from "../src/index.ts";

const development = { ...committedStamp, stamped_by: "development:worker-upmerge-6716f643" };
const staged = { ...committedStamp, stamped_by: "throughline-ship@0.4.26" };

describe("development stamp cannot supply a release identity", () => {
  it("the committed stamp is explicitly development, never a staged release", () => {
    expect(committedStamp.stamped_by.startsWith("development:")).toBe(true);
  });

  it("the default release consumer refuses an otherwise valid development stamp", () => {
    expect(() => readReleaseStamp(() => JSON.stringify(development))).toThrow(
      "RELEASE_STAMP_DEVELOPMENT_NOT_RELEASE",
    );
  });

  it("explicit development consumption retains its version and commit", () => {
    const parsed = readReleaseStamp(() => JSON.stringify(development), undefined, "development");
    expect(parsed.version).toBe(development.version);
    expect(parsed.commit).toBe(development.commit);
  });

  it("a stage-writer label passes classification, without claiming ledger custody or readiness", () => {
    const parsed = readReleaseStamp(() => JSON.stringify(staged));
    expect(parsed.stamped_by).toBe("throughline-ship@0.4.26");
    expect(parsed.version).toBe(staged.version);
  });

  it("an arbitrary writer is not a release producer", () => {
    expect(() =>
      readReleaseStamp(() => JSON.stringify({ ...staged, stamped_by: "worker-fixture" })),
    ).toThrow("RELEASE_STAMP_WRITER_NOT_RELEASE_TOOL");
  });
});
