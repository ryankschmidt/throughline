import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
} from "@t3tools/client-runtime/voice-input";

type SpeechModule = typeof import("expo-speech-recognition").ExpoSpeechRecognitionModule;
type ModelClient = Pick<SpeechModule, "getSupportedLocales" | "androidTriggerOfflineModelDownload">;

function selectLocale(locales: readonly string[], wanted: string) {
  const normalized = (locale: string) => locale.replaceAll("_", "-").toLowerCase();
  return (
    locales.find((locale) => normalized(locale) === normalized(wanted)) ??
    locales.find((locale) => normalized(locale).split("-")[0] === normalized(wanted).split("-")[0])
  );
}

function abortable<T>(request: () => Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfVoiceTranscriptionAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", cancel);
      action();
    };
    const cancel = () =>
      finish(() =>
        reject(new VoiceTranscriptionError("cancelled", "Voice preparation was cancelled.")),
      );
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) {
      cancel();
      return;
    }
    try {
      request().then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

/** Return only a measured installed locale; the OS owns model consent/download, never cloud ASR. */
export async function prepareOfflineSpeechLocale(
  speech: ModelClient,
  wanted: string,
  signal: AbortSignal,
): Promise<string> {
  const read = () =>
    abortable(
      () =>
        speech.getSupportedLocales({ androidRecognitionServicePackage: "com.google.android.as" }),
      signal,
    );
  let available = await read();
  let installed = selectLocale(available.installedLocales, wanted);
  if (installed) return installed;
  const supported = selectLocale(available.locales ?? [], wanted);
  if (supported && typeof speech.androidTriggerOfflineModelDownload === "function") {
    await abortable(() => speech.androidTriggerOfflineModelDownload({ locale: supported }), signal);
    // Success/scheduled/dialog statuses are not installation proof. Query the native service again.
    available = await read();
    installed = selectLocale(available.installedLocales, wanted);
    if (installed) return installed;
  }
  throw new VoiceTranscriptionError(
    "unsupported-locale",
    `Install an offline Android speech model for ${wanted} before dictating.`,
  );
}
