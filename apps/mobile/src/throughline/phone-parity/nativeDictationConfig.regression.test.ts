import { describe, expect, it, vi } from "vite-plus/test";
import {
  AndroidConfig,
  compileModsAsync,
  withPlugins,
  type StaticPlugin,
} from "expo/config-plugins";
import { resolve } from "node:path";
vi.mock("../../../../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({ APP_VARIANT: "development" }),
}));
import appConfig from "../../../app.config";

// Consume the actual configuration and the real Expo plugin chain, not copied permission logic.
async function emittedManifest() {
  const voicePlugins: Array<string | StaticPlugin> = [];
  for (const plugin of appConfig.plugins ?? []) {
    const name = Array.isArray(plugin) ? plugin[0] : plugin;
    if (
      typeof name !== "string" ||
      !["expo-audio", "expo-camera", "expo-image-picker", "expo-speech-recognition"].includes(name)
    )
      continue;
    voicePlugins.push(Array.isArray(plugin) ? [name, plugin[1]] : name);
  }
  const projectRoot = resolve(import.meta.dirname, "../../..");
  const config = withPlugins(
    AndroidConfig.Permissions.withBlockedPermissions(
      {
        _internal: { projectRoot },
        name: appConfig.name,
        slug: appConfig.slug,
        android: { ...appConfig.android },
        ios: { ...appConfig.ios },
      },
      appConfig.android?.blockedPermissions ?? [],
    ),
    voicePlugins,
  );
  const built = await compileModsAsync(config, {
    projectRoot,
    platforms: ["android"],
    introspect: true,
  });
  return built._internal?.modResults?.android?.manifest;
}

describe("native dictation manifest", () => {
  it("permits microphone recording despite the unrelated image-picker/camera configuration", async () => {
    const emitted = await emittedManifest();
    expect(emitted).toBeDefined();
    const permission = emitted.manifest["uses-permission"]?.find(
      (p: { $: Record<string, string> }) =>
        p.$["android:name"] === "android.permission.RECORD_AUDIO",
    );
    expect(permission).toBeDefined();
    expect(permission?.$["tools:node"]).not.toBe("remove");
  });
  it("makes the actual offline Android speech service discoverable", async () => {
    const emitted = await emittedManifest();
    expect(
      emitted.manifest.queries?.some((q: { package?: Array<{ $: Record<string, string> }> }) =>
        q.package?.some((p) => p.$["android:name"] === "com.google.android.as"),
      ),
    ).toBe(true);
  });
  it("retains camera permission, unrelated activity-recognition block and foreground-only audio", async () => {
    const emitted = await emittedManifest();
    const permissions = emitted.manifest["uses-permission"];
    expect(
      permissions?.some(
        (p: { $: Record<string, string> }) =>
          p.$["android:name"] === "android.permission.CAMERA" && p.$["tools:node"] !== "remove",
      ),
    ).toBe(true);
    expect(
      permissions?.some(
        (p: { $: Record<string, string> }) =>
          p.$["android:name"] === "android.permission.ACTIVITY_RECOGNITION" &&
          p.$["tools:node"] === "remove",
      ),
    ).toBe(true);
    expect(
      permissions?.some(
        (p: { $: Record<string, string> }) =>
          p.$["android:name"] === "android.permission.FOREGROUND_SERVICE_MICROPHONE" &&
          p.$["tools:node"] !== "remove",
      ),
    ).not.toBe(true);
  });
});
