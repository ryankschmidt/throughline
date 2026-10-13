import { describe, expect, it, vi } from "vite-plus/test";
import { createAndroidRecordingSession } from "./recordingAudioSession";
const fixture = () => {
  const audio = {
    setIsAudioActiveAsync: vi.fn(async (_active: boolean) => {}),
    setAudioModeAsync: vi.fn(async (_mode: unknown) => {}),
  };
  const original = {
    options: {
      numberOfChannels: 2,
      sampleRate: 44100,
      bitRate: 128000,
      audioEncoder: "aac",
      extension: ".m4a",
      isMeteringEnabled: true,
    },
    configure: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
  };
  return { audio, original };
};
describe("platform recording session, not playback routing", () => {
  it("Android activates capture without invoking the original forced playback route", async () => {
    const { audio, original } = fixture();
    await createAndroidRecordingSession("android", original, audio).configure();
    expect(original.configure).not.toHaveBeenCalled();
    expect(audio.setIsAudioActiveAsync.mock.calls).toEqual([[true]]);
  });
  it("Android release uses helper-owned cleanup instead of the original callback", async () => {
    const { audio, original } = fixture();
    await createAndroidRecordingSession("android", original, audio).release();
    expect(original.release).not.toHaveBeenCalled();
    expect(audio.setIsAudioActiveAsync.mock.calls).toEqual([[false]]);
  });
  it("iOS retains the exact original options and callbacks, without wrapping them", () => {
    const { audio, original } = fixture();
    expect(createAndroidRecordingSession("ios", original, audio)).toBe(original);
    expect(audio.setIsAudioActiveAsync).not.toHaveBeenCalled();
  });
  it("other platforms retain the original behavior rather than adopting Android policy", () => {
    const { audio, original } = fixture();
    expect(createAndroidRecordingSession("web", original, audio)).toBe(original);
  });
  it("setup failure attempts release but preserves the initiating error", async () => {
    const { audio, original } = fixture(),
      setup = Error("setup"),
      cleanup = Error("cleanup");
    audio.setIsAudioActiveAsync.mockRejectedValueOnce(setup).mockRejectedValueOnce(cleanup);
    await expect(
      createAndroidRecordingSession("android", original, audio).configure(),
    ).rejects.toBe(setup);
    expect(audio.setIsAudioActiveAsync.mock.calls).toEqual([[true], [false]]);
    expect(original.configure).not.toHaveBeenCalled();
  });
  it("explicit Android mono contract preserves all other fields without mutating input", () => {
    const { audio, original } = fixture(),
      session = createAndroidRecordingSession("android", original, audio);
    expect(session.options).toEqual({ ...original.options, numberOfChannels: 1 });
    expect(original.options.numberOfChannels).toBe(2);
  });
});

describe("native full-input communication capture regression", () => {
  it("clears Android speaker routing before activating capture", async () => {
    const { audio, original } = fixture();
    await createAndroidRecordingSession("android", original, audio).configure();
    expect(audio.setAudioModeAsync.mock.calls).toEqual([
      [
        {
          allowsRecording: true,
          interruptionMode: "doNotMix",
          playsInSilentMode: true,
          shouldPlayInBackground: false,
          shouldRouteThroughEarpiece: true,
        },
      ],
    ]);
    expect(audio.setAudioModeAsync.mock.invocationCallOrder[0]).toBeLessThan(
      audio.setIsAudioActiveAsync.mock.invocationCallOrder[0]!,
    );
  });
  it("restores original normal-mode release after capture stops", async () => {
    const { audio, original } = fixture();
    await createAndroidRecordingSession("android", original, audio).release();
    expect(audio.setAudioModeAsync.mock.calls).toEqual([[{ allowsRecording: false }]]);
    expect(audio.setIsAudioActiveAsync.mock.calls).toEqual([[false]]);
  });
  it("deactivates when restoring normal mode fails", async () => {
    const { audio, original } = fixture(),
      error = Error("restore mode");
    audio.setAudioModeAsync.mockRejectedValueOnce(error);
    await expect(createAndroidRecordingSession("android", original, audio).release()).rejects.toBe(
      error,
    );
    expect(audio.setIsAudioActiveAsync.mock.calls).toEqual([[false]]);
  });
  it("preserves setup failure while attempting mode and activation cleanup", async () => {
    const { audio, original } = fixture(),
      error = Error("configure mode");
    audio.setAudioModeAsync.mockRejectedValueOnce(error);
    await expect(
      createAndroidRecordingSession("android", original, audio).configure(),
    ).rejects.toBe(error);
    expect(audio.setAudioModeAsync.mock.calls).toHaveLength(2);
    expect(audio.setIsAudioActiveAsync.mock.calls).toEqual([[false]]);
  });
});
