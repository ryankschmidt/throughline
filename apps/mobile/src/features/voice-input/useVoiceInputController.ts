import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { mobilePreferencesAtom } from "../../state/preferences";
import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import { OptimizationCapture } from "../../throughline/voice/optimizationCapture";
import type { VoiceInputSession } from "./voiceInputSession";
import {
  voiceInputBlocksSubmission,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";

import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { useGlobalVoiceInput } from "./VoiceInputProvider";
import { createVoiceInputTarget } from "./voiceInputSession";

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };
const captures = new WeakMap<VoiceInputSession, OptimizationCapture>();

export function useVoiceInputController(input: {
  readonly ownerKey: string | null;
  /** Shown by the global dictation pill when this composer is off screen. */
  readonly label: string;
  readonly readDraftMessage: () => string | null;
  readonly subscribeToDraftChanges: (onChange: () => void) => () => void;
  readonly selection: ComposerEditorSelection;
  readonly disabled?: boolean;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onChangeSelection: (selection: ComposerEditorSelection) => void;
}) {
  const [, refresh] = useState(0);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const preferenceRef = useRef(preferences);
  preferenceRef.current = preferences;
  const global = useGlobalVoiceInput();
  const { setOwnerFocused, session } = global;
  const latestInput = useRef(input);
  latestInput.current = input;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      const ownerKey = input.ownerKey;
      if (!ownerKey) return;
      setOwnerFocused(ownerKey, true);
      return () => setOwnerFocused(ownerKey, false);
    }, [input.ownerKey, setOwnerFocused]),
  );

  const start = useCallback(() => {
    const captured = latestInput.current;
    if (!captured.ownerKey || captured.disabled || global.isBusy) return;
    captures.get(session)?.detach();
    const capture = new OptimizationCapture(
      captured.ownerKey,
      captured.readDraftMessage,
      captured.subscribeToDraftChanges,
    );
    captures.set(session, capture);
    refresh((value) => value + 1);
    void session.start({
      getTranscriber: () => {
        const local = getLocalVoiceTranscriber();
        return local
          ? capture.wrap(
              local,
              () => {
                const current = preferenceRef.current;
                return AsyncResult.isSuccess(current) && !current.waiting
                  ? (current.value.voiceOptimizationProvider ?? "claude")
                  : "off";
              },
              fetch,
            )
          : null;
      },
      onSettled: () => capture.settled(),
      ...createVoiceInputTarget(
        captured.ownerKey,
        captured.readDraftMessage,
        (text, selection) => {
          capture.commit(text, captured.selection, () => captured.onChangeDraftMessage(text));
          if (mounted.current && latestInput.current.ownerKey === captured.ownerKey) {
            latestInput.current.onChangeSelection(selection);
            refresh((value) => value + 1);
          }
        },
        captured.selection,
        captured.subscribeToDraftChanges,
      ),
      label: captured.label,
    });
  }, [session, global.isBusy]);
  const state = global.ownerKey === input.ownerKey ? global.state : IDLE_STATE;
  const isBusy = voiceInputBlocksSubmission(state);
  const capture = captures.get(session);
  const ownedCapture = capture?.ownerKey === input.ownerKey ? capture : undefined;
  const undoOptimization = () => {
    if (isBusy) return false;
    const restored = ownedCapture?.restore(latestInput.current.selection);
    if (!restored) return false;
    latestInput.current.onChangeSelection(restored.selection);
    latestInput.current.onChangeDraftMessage(restored.text);
    refresh((value) => value + 1);
    return true;
  };
  return {
    rawTranscript: ownedCapture?.rawTranscript ?? null,
    optimizationResult: ownedCapture?.result ?? null,
    canUndoOptimization: !isBusy && (ownedCapture?.canUndo(input.selection) ?? false),
    undoOptimization,
    isAvailable: global.isAvailable && (!global.isBusy || global.ownerKey === input.ownerKey),
    state,
    audioLevels: global.audioLevels,
    elapsedSeconds: global.elapsedSeconds,
    isBusy,
    freezesEditor: isBusy,
    blocksSubmission: isBusy,
    start,
    stop: global.stop,
    cancel: global.cancel,
  };
}
