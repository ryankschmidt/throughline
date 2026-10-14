// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AsyncResult } from "effect/reactivity";

const state = vi.hoisted(() => ({
  preferences: {} as Record<string, unknown>,
  system: "light",
  platform: "ios",
  nativeAppearance: vi.fn(),
  save: vi.fn(),
}));

vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return state.platform;
    },
  },
  useColorScheme: () => state.system,
  Appearance: { setColorScheme: state.nativeAppearance, getColorScheme: () => state.system },
  AppState: { addEventListener: () => ({ remove() {} }) },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) =>
    atom === "preferences" ? AsyncResult.success(state.preferences) : [],
  useAtomSet: () => state.save,
}));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: "preferences",
  updateMobilePreferencesAtom: "save",
}));
vi.mock("../../state/server", () => ({ environmentPublishedThemesAtom: "themes" }));
vi.mock("../../lib/materialYouPalette", () => ({
  isSystemColorsAvailable: false,
  readSystemColorPalettes: () => null,
}));
vi.mock("uniwind", () => ({
  ScopedTheme: ({ children }: { children: ReactNode }) => children,
  ScopedVariables: ({ children }: { children: ReactNode }) => children,
  Uniwind: { updateCSSVariables: vi.fn() },
}));

import {
  AppearancePreferencesProvider,
  useAppearancePreferences,
} from "../../features/settings/appearance/AppearancePreferencesProvider";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let current: ReturnType<typeof useAppearancePreferences>;
function Probe() {
  current = useAppearancePreferences();
  return (
    <div
      style={{
        backgroundColor: current.themeVariables["--color-screen"],
        color: current.themeVariables["--color-foreground"],
      }}
    >
      Phone surface
    </div>
  );
}
function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  act(() =>
    root!.render(
      <AppearancePreferencesProvider>
        <Probe />
      </AppearancePreferencesProvider>,
    ),
  );
}
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  state.preferences = {};
  state.nativeAppearance.mockClear();
  state.save.mockClear();
});

describe("desktop Phosphor at the real phone appearance-provider boundary", () => {
  for (const platform of ["ios", "android"])
    for (const system of ["light", "dark"]) {
      it(`${platform} starts offline with desktop colors while the OS is ${system}`, () => {
        state.platform = platform;
        state.system = system;
        mount();
        expect(current.themeId).toBe("ryan-phosphor-console");
        expect(current.themeAppearance).toBe("dark");
        expect(current.themeVariables["--color-screen"]).toBe("#0e1311");
        expect(current.themeVariables["--color-foreground"]).toBe("#dcebe2");
        expect(host!.firstElementChild?.getAttribute("style")).toContain("rgb(14, 19, 17)");
        expect(state.nativeAppearance).toHaveBeenLastCalledWith("dark");
        expect(current.publishedThemes.some((theme) => theme.id === "ryan-phosphor-console")).toBe(
          true,
        );
      });
    }
  it("preserves an explicit existing palette and mode rather than locking the picker", () => {
    state.preferences = { themeId: "t3-chat", themeMode: "light" };
    state.platform = "ios";
    state.system = "dark";
    mount();
    expect(current.themeId).toBe("t3-chat");
    expect(current.themeMode).toBe("light");
    expect(current.themeAppearance).toBe("light");
    act(() => current.setThemeMode("system"));
    expect(state.save).toHaveBeenLastCalledWith({ themeMode: "system" });
  });

  it("keeps explicit System native behavior without feeding a forced dark override back into per-mode selection", () => {
    state.preferences = {
      lightThemeId: "ryan-phosphor-console",
      darkThemeId: "t3-chat",
      themeMode: "system",
    };
    state.system = "light";
    mount();
    expect(current.themeId).toBe("ryan-phosphor-console");
    expect(current.themeVariables["--color-screen"]).toBe("#0e1311");
    expect(state.nativeAppearance).toHaveBeenLastCalledWith("unspecified");
    state.system = "dark";
    act(() =>
      root!.render(
        <AppearancePreferencesProvider>
          <Probe />
        </AppearancePreferencesProvider>,
      ),
    );
    expect(current.themeId).toBe("t3-chat");
    expect(current.themeMode).toBe("system");
    expect(state.nativeAppearance).not.toHaveBeenCalledWith("dark");
  });
});
