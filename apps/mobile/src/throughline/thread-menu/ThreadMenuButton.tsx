import { lazy, Suspense } from "react";
import { Platform, Pressable } from "react-native";
import { ScreenHeaderButton } from "../../components/ScreenHeaderButton";
import type { useDesktopThreadMenu } from "./useDesktopThreadMenu";

// The iOS header uses its public native menu; do not eagerly load Android-only native modules there.
const AndroidAnchoredMenu = lazy(async () => ({
  default: (await import("../../components/AndroidAnchoredMenu")).AndroidAnchoredMenu,
}));
const IosMenu = lazy(async () => ({
  default: (await import("../../components/ControlPillMenu")).ControlPillMenu,
}));
const IosSymbol = lazy(async () => ({
  default: (await import("../../components/AppSymbol")).SymbolView,
}));

/** Android's generic header menu drops submenu-disabled/destructive metadata. */
export function ThreadMenuButton({ menu }: { menu: ReturnType<typeof useDesktopThreadMenu> }) {
  if (Platform.OS === "ios") {
    return (
      <Suspense fallback={null}>
        <IosMenu
          actions={menu.actions}
          onPressAction={menu.onPressAction}
          title="Thread actions"
          style={{ width: 44, height: 44 }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Thread actions"
            style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
          >
            <IosSymbol
              name="ellipsis"
              size={22}
              tintColorClassName="accent-header-foreground"
              type="monochrome"
            />
          </Pressable>
        </IosMenu>
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <AndroidAnchoredMenu
        actions={menu.actions}
        onPressAction={menu.onPressAction}
        title="Thread actions"
        style={{ width: 44, height: 44 }}
      >
        {(open) => (
          <ScreenHeaderButton accessibilityLabel="Thread actions" icon="ellipsis" onPress={open} />
        )}
      </AndroidAnchoredMenu>
    </Suspense>
  );
}
