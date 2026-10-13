// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { resetVoiceInputGlobalsForTests } from "../../../../../packages/client-runtime/src/voice-input/controller";
import { VoiceInputSession } from "../../features/voice-input/voiceInputSession";

const native = vi.hoisted(() => ({
  platform: "android",
  appState: "active",
  listeners: new Set<(state: string) => void>(),
  global: null as unknown,
  transcriber: null as unknown,
}));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return native.platform;
    },
  },
  AppState: {
    get currentState() {
      return native.appState;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      native.listeners.add(listener);
      return { remove: () => native.listeners.delete(listener) };
    },
  },
}));
vi.mock("@react-navigation/native", () => ({ useFocusEffect: () => {} }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({ _tag: "Initial" }) }));
vi.mock("../../state/preferences", () => ({ mobilePreferencesAtom: {} }));
vi.mock("../../native/voiceTranscription", () => ({
  getLocalVoiceTranscriber: () => native.transcriber,
}));
vi.mock("../../features/voice-input/VoiceInputProvider", () => ({
  useGlobalVoiceInput: () => native.global,
}));
import { useVoiceInputController } from "../../features/voice-input/useVoiceInputController";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  resetVoiceInputGlobalsForTests();
  native.platform = "android";
  native.appState = "active";
  native.listeners.clear();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container?.remove();
});

async function harness() {
  const permission = Promise.withResolvers<{ granted: boolean; canAskAgain: boolean }>();
  const permissionEntered = Promise.withResolvers<void>();
  const prepared = Promise.withResolvers<void>();
  const recording = Promise.withResolvers<void>();
  let draft = "draft";
  const recorder = {
    uri: "file:///public-test-dictation.m4a",
    prepareToRecordAsync: vi.fn(async () => {}),
    record: vi.fn(() => recording.resolve()),
    stop: vi.fn(async () => {}),
  };
  const transcriber = {
    prepare: async () => {
      prepared.resolve();
      return { locale: "en-US", transcribe: async () => "spoken sentence" };
    },
  };
  native.transcriber = transcriber;
  const session = new VoiceInputSession({
    recorder,
    getTranscriber: () => transcriber,
    requestPermission: () => {
      permissionEntered.resolve();
      return permission.promise;
    },
    configureRecording: async () => {},
    releaseRecording: async () => {},
    deleteRecording: () => {},
    onStateChange: () => {},
  });
  const starts: Promise<void>[] = [];
  const originalStart = session.start.bind(session);
  vi.spyOn(session, "start").mockImplementation((target) => {
    const started = originalStart(target);
    starts.push(started);
    return started;
  });
  cleanups.push(async () => {
    permission.resolve({ granted: false, canAskAgain: true });
    session.controller.cancel();
    session.controller.dispose();
    await Promise.allSettled(starts);
  });
  native.global = {
    session,
    isBusy: false,
    setOwnerFocused: () => {},
    ownerKey: "draft-owner",
    state: session.controller.currentState,
    stop: () => session.controller.stop(),
    cancel: () => session.controller.cancel(),
    audioLevels: null,
    elapsedSeconds: 0,
  };
  let input: ReturnType<typeof useVoiceInputController> | undefined;
  function Consumer() {
    input = useVoiceInputController({
      ownerKey: "draft-owner",
      label: "Public test draft",
      readDraftMessage: () => draft,
      subscribeToDraftChanges: () => () => {},
      selection: { start: 5, end: 5 },
      onChangeDraftMessage: (text) => {
        draft = text;
      },
      onChangeSelection: () => {},
    });
    return null;
  }
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<Consumer />));
  const background = async () => {
    native.appState = "background";
    for (const listener of native.listeners) listener("background");
    // This is the existing provider's public controller boundary, not copied logic.
    await session.controller.appMovedToBackground();
  };
  const foreground = () => {
    native.appState = "active";
    for (const listener of native.listeners) listener("active");
  };
  return {
    session,
    recorder,
    permission,
    permissionEntered,
    prepared,
    recording,
    start: () => input!.start(),
    background,
    foreground,
    draft: () => draft,
  };
}

it("Android native permission background does not cancel preparation or record while away", async () => {
  const h = await harness();
  await act(async () => h.start());
  await h.permissionEntered.promise;
  await act(async () => h.background());
  expect(h.session.controller.currentState.phase).toBe("preparing");
  h.permission.resolve({ granted: true, canAskAgain: true });
  await h.prepared.promise;
  expect(h.recorder.record).not.toHaveBeenCalled();
  await act(async () => h.foreground());
  await h.recording.promise;
  await act(async () => h.session.controller.stop());
  expect(h.draft()).toBe("draft spoken sentence");
  expect(h.session.controller.currentState.phase).toBe("idle");
});

it("real background during an Android recording still stops and preserves the draft", async () => {
  const h = await harness();
  h.permission.resolve({ granted: true, canAskAgain: true });
  await act(async () => h.start());
  await h.recording.promise;
  await act(async () => h.background());
  expect(h.recorder.stop).toHaveBeenCalledOnce();
  expect(h.draft()).toBe("draft");
  expect(h.session.controller.currentState.phase).toBe("error");
});

it("iOS preparation background cancellation is unchanged", async () => {
  native.platform = "ios";
  const h = await harness();
  await act(async () => h.start());
  await h.permissionEntered.promise;
  await act(async () => h.background());
  expect(h.session.controller.currentState.phase).toBe("error");
  expect(h.recorder.record).not.toHaveBeenCalled();
  h.permission.resolve({ granted: true, canAskAgain: true });
});
