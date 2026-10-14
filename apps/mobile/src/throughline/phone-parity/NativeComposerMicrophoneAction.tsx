import { Linking, Pressable, View } from "react-native";
import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import type { VoiceComposerPresentation } from "../../features/voice-input/voiceInputPresentation";
import { SymbolView } from "../../components/AppSymbol";
import { nativeMicPresentation, pressNativeMic } from "./nativeMicAction";

/** Projects the existing voice session; owns neither recording nor app colors. */
export function NativeComposerMicrophoneAction(props: {
  readonly state: VoiceInputState;
  readonly presentation: VoiceComposerPresentation;
  readonly isAvailable: boolean;
  readonly disabled?: boolean;
  readonly onStart: () => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const presentation = nativeMicPresentation(props);
  if (!presentation.visible) return null;
  return (
    <Pressable
      accessibilityLabel={presentation.label}
      accessibilityRole="button"
      accessibilityState={{ disabled: presentation.disabled, selected: presentation.selected }}
      disabled={presentation.disabled}
      className="size-[44px] items-center justify-center active:opacity-70"
      style={{ opacity: presentation.disabled ? 0.45 : 1 }}
      onPress={() => {
        void pressNativeMic(props, {
          start: props.onStart,
          finish: props.onConfirm,
          cancel: props.onCancel,
          openSettings: () => Linking.openSettings(),
        });
      }}
    >
      <View className="items-center justify-center">
        <SymbolView
          name="mic"
          size={20}
          weight="regular"
          tintColorClassName="accent-icon"
          type="monochrome"
        />
      </View>
    </Pressable>
  );
}
