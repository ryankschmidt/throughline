// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  preference: null as unknown,
  global: null as unknown,
  record: vi.fn(),
  stop: vi.fn(async () => undefined),
  transcribe: vi.fn(async () => "um\nraw words"),
}));
vi.mock("expo-audio", () => ({
  RecordingPresets: { HIGH_QUALITY: {} },
  requestRecordingPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
  setAudioModeAsync: async () => undefined,
  setIsAudioActiveAsync: async () => undefined,
  useAudioRecorder: () => ({
    uri: "file:///voice.m4a",
    prepareToRecordAsync: async () => undefined,
    record: mocks.record,
    stop: mocks.stop,
    getStatus: () => ({ isRecording: false, durationMillis: 0 }),
  }),
}));
vi.mock("expo-file-system", () => ({
  File: class {
    delete() {}
  },
}));
vi.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: async () => undefined,
  deactivateKeepAwake: () => {},
}));
vi.mock("@react-navigation/native", async () => {
  const React = await import("react");
  return { useFocusEffect: (callback: () => () => void) => React.useEffect(callback, [callback]) };
});
// Android preparation has its own regression test; this contract runs the plain-platform path.
vi.mock("react-native", () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: "ios" },
}));
vi.mock("react-native-reanimated", async () => {
  const React = await import("react");
  return { useSharedValue: (value: unknown) => React.useRef({ value }).current };
});
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.preference }));
vi.mock("../../state/preferences", () => ({ mobilePreferencesAtom: {} }));
vi.mock("../showcase/nativeShowcaseScene", () => ({ getNativeShowcaseScene: () => null }));
vi.mock("../../native/voiceTranscription", () => ({
  getLocalVoiceTranscriber: () => ({
    prepare: async () => ({ locale: "en-US", transcribe: mocks.transcribe }),
  }),
}));
vi.mock("./VoiceInputProvider", () => ({ useGlobalVoiceInput: () => mocks.global }));
import { VoiceInputSession } from "./voiceInputSession";
import { voiceInputBlocksSubmission } from "@t3tools/client-runtime/voice-input";
import { useVoiceInputController } from "./useVoiceInputController";
let session: VoiceInputSession;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  session = new VoiceInputSession({
    recorder: {
      uri: "file:///voice.m4a",
      prepareToRecordAsync: async () => {},
      record: mocks.record,
      stop: mocks.stop,
    },
    getTranscriber: () => ({
      prepare: async () => ({ locale: "en-US", transcribe: mocks.transcribe }),
    }),
    requestPermission: async () => ({ granted: true, canAskAgain: true }),
    configureRecording: async () => {},
    releaseRecording: async () => {},
    deleteRecording: () => {},
    onStateChange: () => {},
  });
  mocks.global = {
    session,
    setOwnerFocused: () => {},
    stop: () => session.controller.stop(),
    cancel: () => session.cancel(session.ownerKey),
    get state() {
      return session.controller.currentState;
    },
    get ownerKey() {
      return session.ownerKey;
    },
    get isBusy() {
      return voiceInputBlocksSubmission(session.controller.currentState);
    },
    isAvailable: true,
    audioLevels: { value: [] },
    elapsedSeconds: 0,
  };
  mocks.preference = AsyncResult.success({ voiceOptimizationProvider: "claude" });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ optimized: "Clear text." })),
  );
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  container?.remove();
  session?.controller.dispose();
  vi.restoreAllMocks();
});

async function harness() {
  let api!: ReturnType<typeof useVoiceInputController>;
  let setDraft!: React.Dispatch<React.SetStateAction<string>>;
  let setOwner!: React.Dispatch<React.SetStateAction<string>>;
  let draftValue = "";
  const listeners = new Set<() => void>();
  function Harness() {
    const [draft, updateDraft] = React.useState("");
    const [owner, updateOwner] = React.useState("phone:thread");
    const [selection, updateSelection] = React.useState({ start: 0, end: 0 });
    setDraft = updateDraft;
    setOwner = updateOwner;
    draftValue = draft;
    api = useVoiceInputController({
      ownerKey: owner,
      label: "Test composer",
      readDraftMessage: () => draftValue,
      subscribeToDraftChanges: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      selection,
      onChangeDraftMessage: (text) => {
        draftValue = text;
        for (const listener of [...listeners]) listener();
        updateDraft(text);
      },
      onChangeSelection: updateSelection,
    });
    return null;
  }
  container = document.createElement("div");
  document.body.append(container);
  renderer = createRoot(container);
  await act(async () => {
    renderer.render(<Harness />);
  });
  const dictate = async () => {
    let began!: () => void;
    const recorded = new Promise<void>((resolve) => {
      began = resolve;
    });
    mocks.record.mockImplementationOnce(began);
    await act(async () => {
      api.start();
      await recorded;
    });
    await act(async () => {
      await api.stop();
    });
  };
  return {
    read: () => api,
    draft: () => draftValue,
    dictate,
    type: async (text: string) =>
      act(async () => {
        draftValue = text;
        for (const listener of [...listeners]) listener();
        setDraft(text);
      }),
    owner: async (owner: string) => act(async () => setOwner(owner)),
  };
}

describe("voice hook raw and reversal contract", () => {
  it("publishes raw only on commit and restores the original draft with explicit undo", async () => {
    const h = await harness();
    expect(h.read().rawTranscript).toBeNull();
    await h.dictate();
    expect(h.draft()).toBe("Clear text.");
    expect(h.read().rawTranscript).toBe("um\nraw words");
    expect(h.read().canUndoOptimization).toBe(true);
    await act(async () => {
      expect(h.read().undoOptimization()).toBe(true);
    });
    expect(h.draft()).toBe("");
    expect(h.read().rawTranscript).toBe("um\nraw words");
    expect(h.read().canUndoOptimization).toBe(false);
  });
  it("does not overwrite later typing or leak raw text after an owner change", async () => {
    const h = await harness();
    await h.dictate();
    await h.type("new typing");
    expect(h.read().canUndoOptimization).toBe(false);
    await act(async () => {
      expect(h.read().undoOptimization()).toBe(false);
    });
    expect(h.draft()).toBe("new typing");
    await h.owner("phone:other");
    expect(h.read().rawTranscript).toBeNull();
    expect(h.read().canUndoOptimization).toBe(false);
  });
});
