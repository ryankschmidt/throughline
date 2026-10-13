import { spawnSync } from "node:child_process";
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
import { withAndroidDictation } from "./nativeDictationConfig";

// Consume the actual configuration and the real Expo plugin chain, not copied permission logic.
async function emittedManifest() {
  vi.resetModules();
  const { default: appConfig } = await import("../../../app.config");
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
        ...appConfig,
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
  it("leaves the actual iOS voice, camera and image-picker consent output unchanged", async () => {
    vi.resetModules();
    const { default: actual } = await import("../../../app.config");
    const plugins: Array<string | StaticPlugin> = [];
    for (const plugin of actual.plugins ?? []) {
      const name = Array.isArray(plugin) ? plugin[0] : plugin;
      if (
        typeof name === "string" &&
        ["expo-audio", "expo-camera", "expo-image-picker"].includes(name)
      )
        plugins.push(Array.isArray(plugin) ? [name, plugin[1]] : name);
    }
    const projectRoot = resolve(import.meta.dirname, "../../..");
    const input = () => ({
      name: actual.name,
      slug: actual.slug,
      ios: structuredClone(actual.ios),
      android: structuredClone(actual.android),
      _internal: { projectRoot },
    });
    const before = withPlugins(input(), plugins);
    const after = withPlugins(withAndroidDictation(input()), plugins);
    const beforeBuilt = await compileModsAsync(before, {
      projectRoot,
      platforms: ["ios"],
      introspect: true,
    });
    const afterBuilt = await compileModsAsync(after, {
      projectRoot,
      platforms: ["ios"],
      introspect: true,
    });
    expect(beforeBuilt._internal?.modResults?.ios?.infoPlist).toBeDefined();
    expect(afterBuilt._internal?.modResults?.ios).toEqual(beforeBuilt._internal?.modResults?.ios);
    expect(afterBuilt.ios).toEqual(beforeBuilt.ios);
  });
  it("loads the actual app config through Expo's Node evaluator, not only Vitest", () => {
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        "const {getConfig}=require('expo/config');const c=getConfig(process.cwd(),{skipPlugins:true});if(c.exp.android?.package!=='us.wccert.throughline.dev')process.exit(3);console.log('NATIVE_CONFIG_LOADED')",
      ],
      {
        cwd: resolve(import.meta.dirname, "../../.."),
        env: {
          NODE_ENV: "test",
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          APP_VARIANT: "development",
          EXPO_NO_DOTENV: "1",
          EXPO_NO_GIT_STATUS: "1",
        },
        encoding: "utf8",
      },
    );
    expect({ exit: result.status, loaded: result.stdout.includes("NATIVE_CONFIG_LOADED") }).toEqual(
      { exit: 0, loaded: true },
    );
  });
});
