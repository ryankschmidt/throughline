import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  resetVoiceInputGlobalsForTests,
  voiceInputBlocksSubmission,
} from "../../../../../packages/client-runtime/src/voice-input/controller";
import {
  createVoiceInputTarget,
  VoiceInputSession,
} from "../../features/voice-input/voiceInputSession";
import { pressNativeMic, nativeMicPresentation, nativeVoiceSendVisible } from "./nativeMicAction";

function fixture() {
  let draft = "Keep this draft";
  const recorder = {
    uri: "file:///controlled-voice.m4a",
    prepareToRecordAsync: vi.fn(async () => {}),
    record: vi.fn(),
    stop: vi.fn(async () => {}),
  };
  const transcribe = vi.fn(async () => "more draft visibility and compact attachments");
  const prepare = vi.fn(async () => ({ locale: "en-US", transcribe }));
  const requestPermission = vi.fn(async () => ({ granted: true, canAskAgain: true }));
  const session = new VoiceInputSession({
    recorder,
    getTranscriber: () => ({ prepare }),
    requestPermission,
    configureRecording: async () => {},
    releaseRecording: async () => {},
    deleteRecording: vi.fn(),
    onStateChange: vi.fn(),
  });
  const start = () =>
    session.start(
      createVoiceInputTarget(
        "mic-parity",
        () => draft,
        (text) => {
          draft = text;
        },
        { start: draft.length, end: draft.length },
        () => () => {},
      ),
    );
  const actions = {
    start,
    finish: () => session.controller.stop(),
    cancel: () => session.controller.cancel(),
    openSettings: vi.fn(async () => {}),
  };
  const input = (disabled = false) => ({
    state: session.controller.currentState,
    isAvailable: true,
    disabled,
  });
  return {
    recorder,
    transcribe,
    prepare,
    requestPermission,
    session,
    actions,
    input,
    draft: () => draft,
  };
}

describe("desktop-parity phone microphone interaction", () => {
  beforeEach(() => resetVoiceInputGlobalsForTests());

  it("the same microphone starts and finishes the real shared session without losing later ideas", async () => {
    const f = fixture();
    expect(await pressNativeMic(f.input(), f.actions)).toBe(true);
    expect(f.session.controller.currentState.phase).toBe("recording");
    expect(nativeMicPresentation(f.input()).icon).toBe("mic");
    expect(nativeMicPresentation(f.input()).label).toBe("Finish dictation");
    // Send/external work may be disabled, but finishing one's recording still works.
    expect(await pressNativeMic(f.input(true), f.actions)).toBe(true);
    expect(f.recorder.record).toHaveBeenCalledTimes(1);
    expect(f.recorder.stop).toHaveBeenCalledTimes(1);
    expect(f.draft()).toBe("Keep this draft more draft visibility and compact attachments");
    expect(f.session.controller.currentState.phase).toBe("idle");
  });

  it("preparation freezes the mic and send rather than starting a second recorder", async () => {
    const f = fixture();
    const gate = Promise.withResolvers<{ locale: string; transcribe: typeof f.transcribe }>();
    const entered = Promise.withResolvers<void>();
    f.prepare.mockImplementationOnce(() => {
      entered.resolve();
      return gate.promise;
    });
    const starting = pressNativeMic(f.input(), f.actions);
    await entered.promise;
    expect(f.session.controller.currentState.phase).toBe("preparing");
    expect(nativeMicPresentation(f.input()).disabled).toBe(true);
    expect(nativeVoiceSendVisible(false, f.session.controller.currentState)).toBe(true);
    expect(voiceInputBlocksSubmission(f.session.controller.currentState)).toBe(true);
    expect(await pressNativeMic(f.input(), f.actions)).toBe(false);
    expect(f.prepare).toHaveBeenCalledTimes(1);
    gate.resolve({ locale: "en-US", transcribe: f.transcribe });
    await starting;
    f.session.controller.cancel();
  });

  it("transcription keeps send visible but disabled and ignores another microphone tap", async () => {
    const f = fixture();
    const gate = Promise.withResolvers<string>();
    const entered = Promise.withResolvers<void>();
    f.transcribe.mockImplementationOnce(() => {
      entered.resolve();
      return gate.promise;
    });
    await pressNativeMic(f.input(), f.actions);
    const finishing = pressNativeMic(f.input(), f.actions);
    await entered.promise;
    expect(f.session.controller.currentState.phase).toBe("transcribing");
    expect(nativeMicPresentation(f.input()).label).toBe("Transcribing voice input");
    expect(nativeMicPresentation(f.input()).disabled).toBe(true);
    expect(nativeVoiceSendVisible(false, f.session.controller.currentState)).toBe(true);
    expect(voiceInputBlocksSubmission(f.session.controller.currentState)).toBe(true);
    expect(await pressNativeMic(f.input(), f.actions)).toBe(false);
    expect(f.draft()).toBe("Keep this draft");
    gate.resolve("all later ideas retained");
    await finishing;
    expect(f.draft()).toBe("Keep this draft all later ideas retained");
    expect(f.recorder.record).toHaveBeenCalledTimes(1);
  });

  it.each(["unavailable", "disabled"] as const)(
    "does not open recording when %s",
    async (reason) => {
      const f = fixture();
      const input = { ...f.input(reason === "disabled"), isAvailable: reason !== "unavailable" };
      expect(await pressNativeMic(input, f.actions)).toBe(false);
      expect(f.requestPermission).not.toHaveBeenCalled();
      expect(f.recorder.record).not.toHaveBeenCalled();
      expect(f.draft()).toBe("Keep this draft");
    },
  );

  it("retains native permission-settings recovery and clears the failed session before navigation", async () => {
    const f = fixture();
    f.requestPermission.mockResolvedValueOnce({ granted: false, canAskAgain: false });
    await pressNativeMic(f.input(), f.actions);
    expect(f.session.controller.currentState.phase).toBe("error");
    expect(nativeMicPresentation(f.input()).label).toBe("Open microphone settings");
    f.actions.openSettings.mockImplementationOnce(async () => {
      expect(f.session.controller.currentState.phase).toBe("idle");
      expect(f.draft()).toBe("Keep this draft");
    });
    await pressNativeMic(f.input(), f.actions);
    expect(f.actions.openSettings).toHaveBeenCalledTimes(1);
    expect(f.recorder.record).not.toHaveBeenCalled();
  });
});
