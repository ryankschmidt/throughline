import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../../../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({ APP_VARIANT: "development" }),
}));

const mobileRoot = resolve(import.meta.dirname, "../../..");

describe("approved desktop artwork on phone native surfaces", () => {
  it("uses the carried desktop TL raster for the actual iOS and Android app icons", async () => {
    const { default: config } = await import("../../../app.config");
    expect(config.ios?.icon).toBe("./assets/throughline-icon.png");
    expect(config.android?.icon).toBe("./assets/throughline-icon.png");
    expect(readFileSync(resolve(mobileRoot, String(config.icon)))).toEqual(
      readFileSync(resolve(mobileRoot, "../../assets/prod/black-macos-1024.png")),
    );
  });

  it("does not use the stock T3 glyph layers for Android adaptive and monochrome icons", async () => {
    const { default: config } = await import("../../../app.config");
    const adaptive = config.android?.adaptiveIcon;
    expect(adaptive?.foregroundImage).toBe(
      "./src/throughline/phone-parity/assets/desktop-adaptive-foreground.png",
    );
    expect(adaptive?.monochromeImage).toBe(
      "./src/throughline/phone-parity/assets/desktop-monochrome.png",
    );
    expect(adaptive?.backgroundImage).toBeUndefined();
    expect(adaptive?.backgroundColor).toBe("#000000");
  });

  it("uses the same TL artwork on the actual Android splash in both OS appearances", async () => {
    const { default: config } = await import("../../../app.config");
    const entry = config.plugins?.find((p) => Array.isArray(p) && p[0] === "expo-splash-screen");
    expect(Array.isArray(entry)).toBe(true);
    const options = (entry as [string, { android: { image: string; dark: { image: string } } }])[1];
    expect(options.android.image).toBe(
      "./src/throughline/phone-parity/assets/desktop-adaptive-foreground.png",
    );
    expect(options.android.dark.image).toBe(options.android.image);
  });
});
