import type { VoiceDraftSnapshot, VoiceTranscriber } from "@t3tools/client-runtime/voice-input";
import {
  withMessageOptimizer,
  type OptimizerFetch,
  type VoiceOptimizationProvider,
  type VoiceOptimizationResult,
} from "../../features/voice-input/messageOptimizer";
import {
  createVoiceUndo,
  restoreVoiceUndo,
  type VoiceUndo,
} from "../../features/voice-input/voiceOptimizationUndo";

/** Owns the raw/optimized receipt for one draft, independent of its mounted composer. */
export class OptimizationCapture {
  rawTranscript: string | null = null;
  result: VoiceOptimizationResult | null = null;
  private pendingRaw: string | null = null;
  private pendingResult: VoiceOptimizationResult | null = null;
  private undo: VoiceUndo | null = null;
  private revision = 0;
  private unsubscribe: (() => void) | null;

  constructor(
    readonly ownerKey: string,
    private readonly readText: () => string | null,
    subscribe: (onChange: () => void) => () => void,
  ) {
    let previousText = readText();
    this.unsubscribe = subscribe(() => {
      const text = readText();
      if (text === previousText) return;
      previousText = text;
      this.revision += 1;
      // Once committed, any later typing invalidates undo, including change-and-revert.
      const committedNotification =
        this.undo !== null &&
        text === this.undo.afterText &&
        this.revision === this.undo.afterRevision;
      if (this.result !== null && !committedNotification) {
        this.undo = null;
        if (text === "") this.result = null;
        this.detach();
      }
    });
  }

  wrap(
    transcriber: VoiceTranscriber,
    getProvider: () => VoiceOptimizationProvider,
    fetcher: OptimizerFetch,
  ): VoiceTranscriber {
    return withMessageOptimizer(
      transcriber,
      getProvider,
      fetcher,
      (result) => {
        this.pendingResult = result;
      },
      (raw) => {
        this.pendingRaw = raw;
      },
    );
  }

  commit(text: string, selection: VoiceDraftSnapshot["selection"], write: () => void): void {
    const beforeText = this.readText();
    const undo =
      beforeText !== null && this.pendingRaw !== null
        ? createVoiceUndo(
            { ownerKey: this.ownerKey, text: beforeText, selection, revision: this.revision },
            text,
            this.pendingRaw,
          )
        : null;
    write();
    this.undo = undo;
    this.rawTranscript = this.pendingRaw;
    this.result = this.pendingResult;
    this.pendingRaw = null;
    this.pendingResult = null;
  }

  private snapshot(selection: VoiceDraftSnapshot["selection"]): VoiceDraftSnapshot | null {
    const text = this.readText();
    return text === null
      ? null
      : { ownerKey: this.ownerKey, text, selection, revision: this.revision };
  }

  canUndo(selection: VoiceDraftSnapshot["selection"]): boolean {
    return restoreVoiceUndo(this.undo, this.snapshot(selection)) !== null;
  }

  restore(selection: VoiceDraftSnapshot["selection"]) {
    const restored = restoreVoiceUndo(this.undo, this.snapshot(selection));
    if (restored) {
      this.undo = null;
      this.result = null;
      this.detach();
    }
    return restored;
  }

  settled(): void {
    this.pendingRaw = null;
    this.pendingResult = null;
    if (this.result === null) this.detach();
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
