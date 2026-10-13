import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";

export type NativeMicInput = {
  readonly state: VoiceInputState;
  readonly isAvailable: boolean;
  readonly disabled?: boolean;
};

/** The desktop's microphone toggle, with the phone's existing settings recovery. */
export function nativeMicPresentation({ state, isAvailable, disabled }: NativeMicInput) {
  const recording = state.phase === "recording";
  const preparing = state.phase === "preparing";
  const transcribing = state.phase === "transcribing";
  const settings = state.phase === "error" && state.errorAction === "settings";
  return {
    visible: isAvailable,
    icon: "mic" as const,
    selected: recording,
    disabled: preparing || transcribing || (!recording && Boolean(disabled)),
    action: recording ? "finish" : settings ? "settings" : "start",
    label: recording
      ? "Finish dictation"
      : preparing
        ? "Preparing voice input"
        : transcribing
          ? "Transcribing voice input"
          : settings
            ? "Open microphone settings"
            : "Start dictation",
  };
}

export async function pressNativeMic(
  input: NativeMicInput,
  actions: {
    readonly start: () => void | Promise<void>;
    readonly finish: () => void | Promise<void>;
    readonly cancel: () => void;
    readonly openSettings: () => void | Promise<void>;
  },
): Promise<boolean> {
  const presentation = nativeMicPresentation(input);
  if (!presentation.visible || presentation.disabled) return false;
  if (presentation.action === "finish") await actions.finish();
  else if (presentation.action === "settings") {
    actions.cancel();
    await actions.openSettings();
  } else await actions.start();
  return true;
}

/** Keep Send in its usual place, disabled by the existing submission guard. */
export function nativeVoiceSendVisible(defaultVisible: boolean, state: VoiceInputState): boolean {
  return (
    defaultVisible ||
    state.phase === "preparing" ||
    state.phase === "recording" ||
    state.phase === "transcribing"
  );
}
