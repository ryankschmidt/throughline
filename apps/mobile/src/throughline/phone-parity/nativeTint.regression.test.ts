import { describe, expect, it } from "vite-plus/test";
import { addDesktopWindowTint } from "./nativeTint";
import desktop from "./desktop-theme.json";

const original = `internal import Expo

@objc(SceneDelegate)
class SceneDelegate: ExpoAppSceneDelegate {
  // Extension point for config plugins.
}
`;

describe("desktop accent at the existing Expo scene/window seam", () => {
  it("sets the inherited window tint after the real Expo scene creates the window", () => {
    const source = addDesktopWindowTint(original, desktop.colors.accent);
    expect(source).toContain(
      "super.scene(scene, willConnectTo: session, options: connectionOptions)",
    );
    expect(source).toContain(
      "window?.tintColor = UIColor(red: 74.0 / 255.0, green: 222.0 / 255.0, blue: 128.0 / 255.0, alpha: 1)",
    );
    expect(source.indexOf("super.scene(")).toBeLessThan(source.indexOf("window?.tintColor"));
    expect(source).toContain("internal import UIKit");
    expect(
      source
        .replace(
          /  \/\/ ThroughLine desktop window tint[\s\S]*?  \/\/ End ThroughLine desktop window tint\n/,
          "",
        )
        .replace("internal import UIKit\n", ""),
    ).toBe(original);
  });
  it("refuses an unknown scene lifecycle instead of silently skipping the launch tint", () => {
    expect(() =>
      addDesktopWindowTint(
        original.replace("ExpoAppSceneDelegate", "OtherDelegate"),
        desktop.colors.accent,
      ),
    ).toThrow("PHONE_NATIVE_TINT_SCENE_ANCHOR_CHANGED");
    expect(() => addDesktopWindowTint(original, "green")).toThrow(
      "PHONE_NATIVE_TINT_INVALID_ACCENT",
    );
  });
  it("does not duplicate the generated lifecycle override on another prebuild", () => {
    const once = addDesktopWindowTint(original, desktop.colors.accent);
    expect(addDesktopWindowTint(once, desktop.colors.accent)).toBe(once);
  });
  it("refuses a marker-only foreign scene rather than treating its comment as proof", () => {
    expect(() =>
      addDesktopWindowTint(
        "internal import Expo\nclass SceneDelegate: OtherDelegate {\n  // ThroughLine desktop window tint\n}\n",
        desktop.colors.accent,
      ),
    ).toThrow("PHONE_NATIVE_TINT_SCENE_ANCHOR_CHANGED");
    expect(() =>
      addDesktopWindowTint(
        original.replace(
          "  // Extension point",
          "  // ThroughLine desktop window tint\n  // Extension point",
        ),
        desktop.colors.accent,
      ),
    ).toThrow();
  });
  it("validates the generated old override then refreshes its exact accent", () => {
    const once = addDesktopWindowTint(original, desktop.colors.accent);
    const updated = addDesktopWindowTint(once, "#ff0000");
    expect(updated).toContain("red: 255.0 / 255.0, green: 0.0 / 255.0, blue: 0.0 / 255.0");
    expect(updated).not.toContain("green: 222.0");
    expect(() =>
      addDesktopWindowTint(once.replace("super.scene(", "other.scene("), desktop.colors.accent),
    ).toThrow();
  });
});
