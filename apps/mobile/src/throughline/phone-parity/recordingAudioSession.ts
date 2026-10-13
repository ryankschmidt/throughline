type RecordingInput = { readonly uid: string; readonly name: string; readonly type: string };

type RecordingAudioSession<T> = {
  readonly options: T;
  readonly configure: () => Promise<void>;
  readonly release: () => Promise<void>;
  readonly selectInput?: (inputs: ReadonlyArray<RecordingInput>) => RecordingInput | null;
};

/** Android communication capture clears the forced speaker route while recording. */
export function createAndroidRecordingSession<T extends { numberOfChannels: number }>(
  platform: string,
  original: RecordingAudioSession<T>,
  audio: {
    readonly setIsAudioActiveAsync: (active: boolean) => Promise<void>;
    readonly setAudioModeAsync: (mode: {
      allowsRecording: boolean;
      interruptionMode?: "doNotMix";
      playsInSilentMode?: boolean;
      shouldPlayInBackground?: boolean;
      shouldRouteThroughEarpiece?: boolean;
    }) => Promise<void>;
  },
): RecordingAudioSession<T> {
  // Retain the original iOS options and session functions without wrapping them.
  if (platform !== "android") return original;
  const release = async () => {
    try {
      await audio.setAudioModeAsync({ allowsRecording: false });
    } finally {
      await audio.setIsAudioActiveAsync(false);
    }
  };
  return {
    options: { ...original.options, numberOfChannels: 1 },
    selectInput: original.selectInput
      ? (inputs) => {
          const selected = original.selectInput!(inputs);
          // Keep preference bookkeeping, but do not re-pin the sole default input.
          // Actual Android capture went silent after that redundant native setInput.
          return inputs.length === 1 && selected?.uid === inputs[0]?.uid ? null : selected;
        }
      : undefined,
    configure: async () => {
      try {
        // On Android this SDK flag sets communication mode and speakerphone OFF,
        // rather than pinning the speaker route used by playback setup.
        await audio.setAudioModeAsync({
          allowsRecording: true,
          interruptionMode: "doNotMix",
          playsInSilentMode: true,
          shouldPlayInBackground: false,
          shouldRouteThroughEarpiece: true,
        });
        await audio.setIsAudioActiveAsync(true);
      } catch (error) {
        try {
          await release();
        } catch {
          /* Preserve the setup error. */
        }
        throw error;
      }
    },
    release,
  };
}
