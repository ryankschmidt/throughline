import type { ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ComposerInlineControl } from "../../components/ComposerToolbar";
import { useAndroidControlSizing } from "../../components/useAndroidControlSizing";

/**
 * The composer's model button. It is the stock inline control unless the thread's live
 * model is unavailable; then it carries desktop's outline "Unavailable" tag between the
 * model name and the chevron (apps/web/src/components/chat/ProviderModelPicker.tsx).
 */
export function ComposerModelButton(props: {
  readonly label: string;
  readonly unavailable: boolean;
  readonly renderIcon: (size: number) => ReactNode;
  readonly onPress: () => void;
}) {
  const { scale, smallIconSize } = useAndroidControlSizing();
  if (!props.unavailable) {
    return (
      <ComposerInlineControl
        accessibilityLabel="Model and reasoning settings"
        emphasized
        renderIcon={props.renderIcon}
        label={props.label}
        maxWidth="100%"
        onPress={props.onPress}
      />
    );
  }
  return (
    <Pressable
      accessibilityLabel="Model and reasoning settings"
      accessibilityRole="button"
      className="h-11 flex-row items-center gap-2 rounded-xl px-2 active:bg-subtle"
      onPress={props.onPress}
      style={{ maxWidth: "100%" }}
    >
      <View
        className="size-4 shrink-0 items-center justify-center"
        style={Platform.OS === "android" ? { width: 14 * scale, height: 14 * scale } : undefined}
      >
        {props.renderIcon(smallIconSize)}
      </View>
      <Text className="shrink text-sm font-t3-medium text-foreground" numberOfLines={1}>
        {props.label}
      </Text>
      <View className="shrink-0 rounded-md border border-border px-1.5 py-0.5">
        <Text className="text-3xs font-t3-bold text-foreground">Unavailable</Text>
      </View>
      <SymbolView
        name="chevron.down"
        size={Math.round(10 * scale)}
        tintColorClassName="accent-icon"
        type="monochrome"
      />
    </Pressable>
  );
}
