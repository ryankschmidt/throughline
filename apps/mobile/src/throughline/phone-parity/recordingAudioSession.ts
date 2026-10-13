type RecordingAudioSession<T> = {
  readonly options: T;
  readonly configure: () => Promise<void>;
  readonly release: () => Promise<void>;
};

/** Android dictation must not force a playback route while acquiring the microphone. */
export function createAndroidRecordingSession<T extends { numberOfChannels: number }>(
  platform: string,
  original: RecordingAudioSession<T>,
  audio: { readonly setIsAudioActiveAsync: (active: boolean) => Promise<void> },
): RecordingAudioSession<T> {
  // Retain the original iOS options and session functions without wrapping them.
  if (platform !== "android") return original;
  const release = () => audio.setIsAudioActiveAsync(false);
  return {
    options: { ...original.options, numberOfChannels: 1 },
    configure: async () => {
      try {
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
