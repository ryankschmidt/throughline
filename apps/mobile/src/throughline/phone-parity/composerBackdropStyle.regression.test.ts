import { describe, expect, it } from "vite-plus/test";
import { environmentThemeMobileVariables } from "../../lib/environmentThemePalette";
import { DESKTOP_PHONE_THEME } from "./desktopTheme";
import { quietComposerBackdropStyle } from "./composerBackdropStyle";

describe("original-subtle composer outline", () => {
  it("uses the existing desktop-derived composer border, never a white native-glass highlight", () => {
    const colors = environmentThemeMobileVariables(DESKTOP_PHONE_THEME, "dark");
    const actual = quietComposerBackdropStyle(colors, 1 / 3);
    expect(actual.borderColor).toBe(colors["--color-composer-border"]);
    expect(actual.backgroundColor).toBe(colors["--color-composer-surface"]);
    expect(actual.borderWidth).toBe(1 / 3);
    expect(actual.borderColor).not.toMatch(/white|#fff|255[, ]+255[, ]+255/i);
  });
});
