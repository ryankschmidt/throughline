import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  voiceInputBlocksSubmission,
  voiceInputFreezesEditor,
  type VoiceDraftSnapshot,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import { useOptimizerPreference } from "../composer-optimize/useOptimizerPreference";
import { DesktopVoiceInput, readDesktopVoicePort } from "./DesktopVoiceInput";

const IDLE: VoiceInputState = { phase: "idle", error: null, errorAction: null };
export function useDesktopVoiceInput(ports: {
  ownerKey: string;
  disabled: boolean;
  readDraft: () => VoiceDraftSnapshot | null;
  commitDraft: (text: string, selection: VoiceDraftSnapshot["selection"]) => void;
}) {
  const provider = useOptimizerPreference();
  const latest = useRef({ ports, provider });
  latest.current = { ports, provider };
  const input = useRef<DesktopVoiceInput | null>(null);
  const [available, setAvailable] = useState(false);
  const [state, setState] = useState(IDLE);
  const [, refresh] = useState(0);
  useEffect(() => {
    let disposed = false;
    const bridge = readDesktopVoicePort(window);
    if (!bridge) return;
    void bridge
      .capabilities()
      .then((capability) => {
        if (
          disposed ||
          !capability ||
          typeof capability !== "object" ||
          Reflect.get(capability, "kind") !== "capabilities" ||
          Reflect.get(capability, "available") !== true
        )
          return;
        input.current = new DesktopVoiceInput({
          bridge,
          readDraft: () => latest.current.ports.readDraft(),
          commitDraft: (text, selection) => latest.current.ports.commitDraft(text, selection),
          getProvider: () => latest.current.provider,
          onStateChange: (next) => {
            if (!disposed) setState(next);
          },
        });
        setAvailable(true);
      })
      .catch(() => {
        if (!disposed) setAvailable(false);
      });
    const background = () => {
      if (document.hidden) input.current?.cancel();
    };
    document.addEventListener("visibilitychange", background);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", background);
      input.current?.dispose();
      input.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    input.current?.ownerChanged();
  }, [ports.ownerKey]);
  useEffect(() => {
    if (state.phase !== "recording") return;
    // Same public phone limit. Native AVAudioRecorder also refuses audio after
    // 300 seconds; only the normal controller stop path transcribes/commits.
    const timer = setTimeout(() => {
      void input.current?.controller.stop();
    }, 300_000);
    return () => clearTimeout(timer);
  }, [state.phase]);
  return {
    available,
    state,
    get blocksSubmission() {
      return voiceInputBlocksSubmission(input.current?.controller.currentState ?? state);
    },
    get freezesEditor() {
      return voiceInputFreezesEditor(input.current?.controller.currentState ?? state);
    },
    start: () => {
      if (!latest.current.ports.disabled) void input.current?.controller.start();
    },
    stop: () => {
      void input.current?.controller.stop();
    },
    cancel: () => input.current?.cancel(),
    rawTranscript: input.current?.rawTranscript ?? null,
    outcome: input.current?.outcome ?? null,
    canUndo: input.current?.canUndo() ?? false,
    undo: () => {
      input.current?.undo();
      refresh((value) => value + 1);
    },
  };
}
