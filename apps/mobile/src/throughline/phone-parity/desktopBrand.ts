import type { ExpoConfig } from "expo/config";
import { withDangerousMod } from "expo/config-plugins";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addDesktopWindowTint } from "./nativeTint.ts";

const desktopIcon = "./assets/throughline-icon.png";
const adaptiveForeground = "./src/throughline/phone-parity/assets/desktop-adaptive-foreground.png";
const monochrome = "./src/throughline/phone-parity/assets/desktop-monochrome.png";

// Variant names/package IDs remain distinct. Only the artwork is shared with
// desktop; keep native dictation, release identity and consent configuration intact.
export function withDesktopPhoneBrand(config: ExpoConfig): ExpoConfig {
  const branded: ExpoConfig = {
    ...config,
    icon: desktopIcon,
    ios: { ...config.ios, icon: desktopIcon },
    android: {
      ...config.android,
      icon: desktopIcon,
      adaptiveIcon: {
        foregroundImage: adaptiveForeground,
        backgroundColor: "#000000",
        monochromeImage: monochrome,
      },
    },
    plugins: config.plugins?.map((plugin) => {
      if (!Array.isArray(plugin) || plugin[0] !== "expo-splash-screen") return plugin;
      const options = plugin[1] ?? {};
      return [
        plugin[0],
        {
          ...options,
          image: desktopIcon,
          dark: { ...options.dark, image: desktopIcon },
          android: {
            ...options.android,
            image: adaptiveForeground,
            dark: { ...options.android?.dark, image: adaptiveForeground },
          },
        },
      ];
    }),
  };
  // SceneDelegate owns UIWindow on current Expo. Set the inherited launch tint
  // there rather than opening a new upstream tab-bar source mount.
  return withDangerousMod(branded, [
    "ios",
    async (next) => {
      const root = next.modRequest.projectRoot;
      const scene = join(
        next.modRequest.platformProjectRoot,
        next.modRequest.projectName!,
        "SceneDelegate.swift",
      );
      const definition = JSON.parse(
        readFileSync(join(root, "src/throughline/phone-parity/desktop-theme.json"), "utf8"),
      );
      writeFileSync(
        scene,
        addDesktopWindowTint(readFileSync(scene, "utf8"), definition.colors.accent),
      );
      return next;
    },
  ]);
}
