import { EnvironmentTheme } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  resolveMobileThemeIds,
  type MobileThemeAppearance,
  type MobileThemeId,
} from "../../lib/mobileTheme";
import type { Preferences } from "../../persistence/mobile-preferences";
import desktopDefinition from "./desktop-theme.json";

// Exact desktop definition, SHA-256 ecd070af090ed41ae2fbbe12de1f84d63a7233303259123bc2965ea59edce63c.
// Bundling it prevents a stock-color flash before pairing or while disconnected.
// A connected environment's definition wins; this is not another invented palette.
export const DESKTOP_PHONE_THEME = Schema.decodeUnknownSync(EnvironmentTheme)(desktopDefinition);

export function phoneThemeIds(preferences: Preferences | null) {
  return resolveMobileThemeIds({
    ...preferences,
    themeId: preferences?.themeId ?? DESKTOP_PHONE_THEME.id,
  });
}

export function withDesktopPhoneTheme(themes: ReadonlyArray<EnvironmentTheme>) {
  return themes.some((theme) => theme.id === DESKTOP_PHONE_THEME.id)
    ? themes
    : [...themes, DESKTOP_PHONE_THEME];
}

// Ryan's exported theme has one appearance, not a guessed light counterpart.
// Other existing picker selections keep their ordinary appearance behavior.
export function phoneThemeAppearance(
  id: MobileThemeId,
  requested: MobileThemeAppearance,
  themes: ReadonlyArray<EnvironmentTheme>,
): MobileThemeAppearance {
  return id === DESKTOP_PHONE_THEME.id
    ? (themes.find((theme) => theme.id === id)?.appearance ?? DESKTOP_PHONE_THEME.appearance)
    : requested;
}
