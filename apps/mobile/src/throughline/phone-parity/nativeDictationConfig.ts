import { withAndroidManifest, type ConfigPlugin } from "expo/config-plugins";

/** Native dictation is Android-only here; never change iOS consent or other plugin options. */
export const withAndroidDictation: ConfigPlugin = (config) =>
  withAndroidManifest(config, (next) => {
    const manifest = next.modResults.manifest;
    // Register before the static plugins: Android mods run last-registered-first,
    // so this finalizes voice's required permission after the picker's global removal.
    manifest["uses-permission"] = [
      ...(manifest["uses-permission"] ?? []).filter(
        (permission) => permission.$["android:name"] !== "android.permission.RECORD_AUDIO",
      ),
      { $: { "android:name": "android.permission.RECORD_AUDIO" } },
    ];
    manifest.queries ??= [];
    for (const name of ["com.google.android.as", "com.google.android.googlequicksearchbox"]) {
      if (
        !manifest.queries.some((query) => query.package?.some((p) => p.$["android:name"] === name))
      ) {
        manifest.queries.push({
          package: [{ $: { "android:name": name } }],
          intent: [{ action: [{ $: { "android:name": "android.speech.RecognitionService" } }] }],
        });
      }
    }
    return next;
  });
