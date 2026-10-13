// @effect-diagnostics nodeBuiltinImport:off - explicitly opt-in external-page smoke gate.
import { expect, test } from "vite-plus/test";
import { McpServer } from "effect/ai";
import { assertReadablePng, runPreviewSnapshotScratch } from "./preview-snapshot.scratch.ts";

test("preview pixel gate rejects non-image bytes", () => {
  expect(() => assertReadablePng(new Uint8Array([1, 2, 3]))).toThrow(/PNG/);
});

// This is a release/rehearsal gate, not an implicit browser download in ordinary suites.
test.runIf(process.env.THROUGHLINE_PREVIEW_PIXEL_PROOF === "1")(
  "real external preview snapshot returns pixels and save:true writes readable PNG",
  async () => {
    const result = await runPreviewSnapshotScratch(McpServer.McpServer.layer);
    expect(result.externalUrl).toMatch(/^https:\/\/example\.com\/?$/);
    expect(result.imageBytes).toBeGreaterThan(0);
    expect(result.savedBytes).toBeGreaterThan(0);
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    expect(result.evidencePng).toMatch(/\.png$/);
  },
  180_000,
);
