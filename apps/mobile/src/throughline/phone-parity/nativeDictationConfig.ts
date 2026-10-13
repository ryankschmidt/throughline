import type { ExpoConfig } from "expo/config";

/** Android dictation needs the microphone and its on-device service, not background audio. */
export function nativeDictationPlugins(
  plugins: NonNullable<ExpoConfig["plugins"]>,
): NonNullable<ExpoConfig["plugins"]> {
  return [
    ...plugins.map<NonNullable<ExpoConfig["plugins"]>[number]>((plugin) => {
      if (!Array.isArray(plugin)) return plugin;
      const [name, options] = plugin;
      if (name === "expo-audio") return [name, { ...options, recordAudioAndroid: true }];
      // The picker's false option adds a global manifest removal, also disabling voice input.
      // Keep photo/camera settings; share the already-required microphone consent instead.
      if (name === "expo-image-picker")
        return [
          name,
          {
            ...options,
            microphonePermission: "Allow ThroughLine to use your microphone for voice input.",
          },
        ];
      return plugin;
    }),
    [
      "expo-speech-recognition",
      {
        microphonePermission: "Allow ThroughLine to use your microphone for voice input.",
        speechRecognitionPermission: "Allow ThroughLine to transcribe your voice input.",
        androidSpeechServicePackages: [
          "com.google.android.as",
          "com.google.android.googlequicksearchbox",
        ],
      },
    ],
  ];
}
