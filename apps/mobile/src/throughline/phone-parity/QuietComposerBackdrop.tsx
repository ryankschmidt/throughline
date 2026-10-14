import type { ComponentProps } from "react";
import { StyleSheet, View } from "react-native";
import type { GlassSurface } from "../../components/GlassSurface";
import { useAppearancePreferences } from "../../features/settings/appearance/AppearancePreferencesProvider";
import { quietComposerBackdropStyle } from "./composerBackdropStyle";

/** Background only: keep the original content, radius and animation owner. */
export function QuietComposerBackdrop(props: ComponentProps<typeof GlassSurface>) {
  const { themeVariables } = useAppearancePreferences();
  const {
    chrome: _chrome,
    fallbackClassName: _fallbackClassName,
    fallbackColor: _fallbackColor,
    glassEffectStyle: _glassEffectStyle,
    tintColor: _tintColor,
    tintColorClassName: _tintColorClassName,
    style,
    ...rest
  } = props;
  // Native Liquid Glass adds its own bright specular edge irrespective of the
  // CSS border. Use the same theme border as the old fallback, one physical pixel.
  return (
    <View
      {...rest}
      style={[quietComposerBackdropStyle(themeVariables, StyleSheet.hairlineWidth), style]}
    />
  );
}
