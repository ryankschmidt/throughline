import type { MobileThemeVariables } from "../../lib/mobileTheme";

export function quietComposerBackdropStyle(colors: MobileThemeVariables, hairline: number) {
  return {
    backgroundColor: colors["--color-composer-surface"],
    borderColor: colors["--color-composer-border"],
    borderWidth: hairline,
  };
}
