import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import { Effect, FileSystem } from "effect";

describe("optimizer preference location", () => {
  it.effect("mounts the fork section beside the unchanged General Settings panel", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const source = yield* fs.readFileString(
        NodeURL.fileURLToPath(new URL("../../routes/settings.general.tsx", import.meta.url)),
      );
      expect(source).toContain("<GeneralSettingsPanel />");
      expect(source).toContain("<SettingsVoiceOptimizationSection />");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("keeps Optimize and Undo but removes the provider choice from the composer", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const source = yield* fs.readFileString(
        NodeURL.fileURLToPath(new URL("./ComposerOptimizeControl.tsx", import.meta.url)),
      );
      expect(source).not.toContain('aria-label="Optimization provider"');
      expect(source).toContain("useOptimizerPreference");
      expect(source).toContain('aria-label="Optimize draft or selection"');
      expect(source).toContain('aria-label="Undo optimization"');
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
