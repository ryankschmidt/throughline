import { beforeEach, expect, it, vi } from "vite-plus/test";
const native = vi.hoisted(() => {
  const state = { installed: [] as string[], supported: ["en-US"] as string[] };
  const speech = {
    isRecognitionAvailable: () => true,
    supportsOnDeviceRecognition: () => true,
    supportsRecording: () => true,
    getPermissionsAsync: vi.fn(async () => ({ granted: true })),
    requestPermissionsAsync: vi.fn(async () => ({ granted: true })),
    getSupportedLocales: vi.fn(async () => ({
      locales: state.supported,
      installedLocales: state.installed,
    })),
    androidTriggerOfflineModelDownload: vi.fn(async (_options: { locale: string }) => {
      state.installed = ["en-US"];
      return { status: "download_success" as const, message: "ready" };
    }),
  };
  return { state, speech };
});
vi.mock("react-native", () => ({ Platform: { OS: "android", Version: 36 } }));
vi.mock("expo", () => ({ requireOptionalNativeModule: () => native.speech }));
import { getLocalVoiceTranscriber } from "../../native/voiceTranscription.android";

beforeEach(() => {
  vi.clearAllMocks();
  native.state.installed = [];
  native.state.supported = ["en-US"];
  native.speech.androidTriggerOfflineModelDownload.mockImplementation(async () => {
    native.state.installed = ["en-US"];
    return { status: "download_success", message: "ready" };
  });
});

it("cold Android preparation requests the supported on-device language then verifies installation", async () => {
  const prepared = await getLocalVoiceTranscriber()!.prepare({
    signal: new AbortController().signal,
  });
  expect(prepared.locale).toBe("en-US");
  expect(native.speech.androidTriggerOfflineModelDownload).toHaveBeenCalledOnce();
  expect(native.speech.androidTriggerOfflineModelDownload).toHaveBeenCalledWith({
    locale: "en-US",
  });
  expect(native.speech.getSupportedLocales).toHaveBeenCalledTimes(2);
});
it("an installed language needs no download", async () => {
  native.state.installed = ["en-US"];
  const prepared = await getLocalVoiceTranscriber()!.prepare({
    signal: new AbortController().signal,
  });
  expect(prepared.locale).toBe("en-US");
  expect(native.speech.androidTriggerOfflineModelDownload).not.toHaveBeenCalled();
});
it("abort before preparation never requests a model", async () => {
  const abort = new AbortController();
  abort.abort();
  await expect(getLocalVoiceTranscriber()!.prepare({ signal: abort.signal })).rejects.toMatchObject(
    { code: "cancelled" },
  );
  expect(native.speech.androidTriggerOfflineModelDownload).not.toHaveBeenCalled();
});
it("abort during model consent/download cannot produce a prepared recording", async () => {
  const abort = new AbortController();
  native.speech.androidTriggerOfflineModelDownload.mockImplementation(async () => {
    abort.abort();
    native.state.installed = ["en-US"];
    return { status: "download_success", message: "ready" };
  });
  await expect(getLocalVoiceTranscriber()!.prepare({ signal: abort.signal })).rejects.toMatchObject(
    { code: "cancelled" },
  );
  expect(native.speech.androidTriggerOfflineModelDownload).toHaveBeenCalledOnce();
});
it("a download result alone is not permission to record without an installed locale", async () => {
  native.speech.androidTriggerOfflineModelDownload.mockImplementation(async () => ({
    status: "download_success",
    message: "not installed yet",
  }));
  await expect(
    getLocalVoiceTranscriber()!.prepare({ signal: new AbortController().signal }),
  ).rejects.toMatchObject({ code: "unsupported-locale" });
  expect(native.speech.getSupportedLocales).toHaveBeenCalledTimes(2);
});
it("no matching supported language remains unsupported without a cloud fallback", async () => {
  native.state.supported = ["ja-JP"];
  await expect(
    getLocalVoiceTranscriber()!.prepare({ signal: new AbortController().signal }),
  ).rejects.toMatchObject({ code: "unsupported-locale" });
  expect(native.speech.androidTriggerOfflineModelDownload).not.toHaveBeenCalled();
});
