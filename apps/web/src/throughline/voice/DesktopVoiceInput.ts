import {
  VoiceInputController,
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceDraftSnapshot,
  type VoiceInputState,
  type VoiceRecorder,
} from "@t3tools/client-runtime/voice-input";
import {
  requestOptimization,
  type OptimizationProvider,
} from "../composer-optimize/draftOptimization";
import { randomUUID } from "../../lib/utils";

/** Renderer-only, finite fork namespace. Main owns native paths/audio/cleanup. */
export interface DesktopVoicePort {
  capabilities(): Promise<unknown>;
  start(requestId: string): Promise<unknown>;
  record(requestId: string): Promise<unknown>;
  stop(requestId: string): Promise<unknown>;
  cancel(requestId: string): Promise<unknown>;
}
function value(input: unknown, key: string): unknown {
  return input !== null && typeof input === "object" ? Reflect.get(input, key) : undefined;
}
function reply(input: unknown, kind: string, id: string): void {
  if (value(input, "kind") !== kind || value(input, "requestId") !== id)
    throw new VoiceTranscriptionError("preparation-failed", "Desktop voice request refused.");
}
export function readDesktopVoicePort(host: unknown): DesktopVoicePort | null {
  const port: unknown = value(host, "throughlineVoice");
  if (port === null || typeof port !== "object") return null;
  const capabilities: unknown = value(port, "capabilities"),
    start: unknown = value(port, "start"),
    record: unknown = value(port, "record"),
    stop: unknown = value(port, "stop"),
    cancel: unknown = value(port, "cancel");
  if (
    typeof capabilities !== "function" ||
    typeof start !== "function" ||
    typeof record !== "function" ||
    typeof stop !== "function" ||
    typeof cancel !== "function"
  )
    return null;
  // Do not spread the host, expose raw IPC, or read any other global/config.
  return {
    capabilities: () => capabilities.call(port),
    start: (id) => start.call(port, id),
    record: (id) => record.call(port, id),
    stop: (id) => stop.call(port, id),
    cancel: (id) => cancel.call(port, id),
  };
}

type Ports = {
  bridge: DesktopVoicePort;
  readDraft: () => VoiceDraftSnapshot | null;
  commitDraft: (text: string, selection: VoiceDraftSnapshot["selection"]) => void;
  getProvider: () => OptimizationProvider;
  onStateChange: (state: VoiceInputState) => void;
  request?: typeof requestOptimization;
};

/** Adapts the real native prepare/record boundary to the phone's public
 * protected-draft lifecycle. No permission fiction or early recorder start.
 */
export class DesktopVoiceInput {
  readonly controller: VoiceInputController;
  private committedRaw: string | null = null;
  private committedOutcome: "optimized" | "original-kept" | null = null;
  get rawTranscript(): string | null {
    return this.after?.ownerKey === this.ports.readDraft()?.ownerKey ? this.committedRaw : null;
  }
  get outcome(): "optimized" | "original-kept" | null {
    return this.after?.ownerKey === this.ports.readDraft()?.ownerKey ? this.committedOutcome : null;
  }
  private id: string | null = null;
  private locale: string | null = null;
  private signal: AbortSignal | null = null;
  private stopping: Promise<string> | null = null;
  private cancelling: Promise<void> | null = null;
  private preparation: {
    readonly id: string;
    abandoned: boolean;
    readonly cancelled: ReturnType<typeof Promise.withResolvers<never>>;
  } | null = null;
  private cleanupFailed = false;
  private removeAbortListener: (() => void) | null = null;
  private pendingRaw: string | null = null;
  private pendingOutcome: "optimized" | "original-kept" | null = null;
  private before: VoiceDraftSnapshot | null = null;
  private after: VoiceDraftSnapshot | null = null;
  private readonly ports: Ports;
  constructor(ports: Ports) {
    this.ports = ports;
    const recorder: VoiceRecorder = {
      get uri() {
        return owner.id ? `throughline-voice:${owner.id}` : null;
      },
      prepareToRecordAsync: async () => {
        const id = this.requireId();
        // A real readiness replay, not a dummy recorder preparation.
        const prepared = await ports.bridge.start(id);
        reply(prepared, "prepared", id);
        if (value(prepared, "locale") !== this.locale) throw new Error("Voice preparation changed");
      },
      record: ({ forDuration }) => {
        if (forDuration !== 300) throw new Error("Unsupported voice recording limit");
        this.before = ports.readDraft();
        const id = this.requireId();
        void ports.bridge
          .record(id)
          .then((result) => {
            reply(result, "started", id);
          })
          .catch(() => {
            if (this.id === id && !this.signal?.aborted)
              return this.controller.handleRecorderStatus({
                isFinished: false,
                hasError: true,
                error: "Could not record voice.",
                url: recorder.uri,
              });
          });
      },
      stop: async () => {
        if (this.signal?.aborted) {
          await this.cancelNative();
          return;
        }
        const id = this.requireId();
        this.stopping ??= ports.bridge.stop(id).then((result) => {
          reply(result, "transcribed", id);
          const text = value(result, "text");
          if (typeof text !== "string") throw new Error("Invalid voice transcript");
          return text;
        });
        await this.stopping;
      },
    };
    const owner = this;
    this.controller = new VoiceInputController({
      recorder,
      requestPermission: async () => {
        // The shared controller cannot acquire the next abandoned-session
        // lease until this permission operation settles. Settle it only after
        // owning native cancellation/cleanup, even if start's reply is late.
        if (this.cancelling) await this.cancelling;
        if (this.cleanupFailed) throw new Error("Owned voice cleanup failed");
        this.removeAbortListener?.();
        this.removeAbortListener = null;
        this.id = randomUUID();
        this.locale = null;
        this.stopping = null;
        this.cancelling = null;
        this.pendingRaw = null;
        this.pendingOutcome = null;
        this.before = null;
        this.after = null;
        const id = this.id;
        const preparation = { id, abandoned: false, cancelled: Promise.withResolvers<never>() };
        this.preparation = preparation;
        void preparation.cancelled.promise.catch(() => {});
        try {
          const prepared = await Promise.race([
            ports.bridge.start(id),
            preparation.cancelled.promise,
          ]);
          if (preparation.abandoned || this.id !== id)
            throw new VoiceTranscriptionError("cancelled", "Voice transcription was cancelled.");
          if (
            value(prepared, "kind") === "error" &&
            value(prepared, "code") === "permission-denied"
          ) {
            await this.cancelNative(id);
            return { granted: false, canAskAgain: false };
          }
          reply(prepared, "prepared", id);
          const locale = value(prepared, "locale");
          if (typeof locale !== "string" || !locale.trim())
            throw new Error("Invalid prepared locale");
          this.locale = locale;
          return { granted: true, canAskAgain: true };
        } catch (cause) {
          await this.cancelNative(id);
          throw cause;
        }
      },
      getTranscriber: () => ({
        prepare: async ({ signal }) => {
          this.signal = signal;
          const id = this.requireId();
          const cancel = () => {
            void this.cancelNative(id).catch(() => {
              this.cleanupFailed = true;
            });
          };
          signal.addEventListener("abort", cancel, { once: true });
          this.removeAbortListener = () => signal.removeEventListener("abort", cancel);
          if (signal.aborted) await this.cancelNative(id);
          throwIfVoiceTranscriptionAborted(signal);
          if (!this.locale) throw new Error("Voice was not prepared");
          return {
            locale: this.locale,
            transcribe: async (_uri, { signal }) => {
              if (!this.stopping) throw new Error("Recording has not stopped");
              const raw = await this.stopping;
              throwIfVoiceTranscriptionAborted(signal);
              this.pendingRaw = raw;
              const provider = ports.getProvider();
              if (provider === "off" || !raw.trim()) {
                this.pendingOutcome = "original-kept";
                return raw;
              }
              try {
                const text = await (ports.request ?? requestOptimization)(raw, provider, signal);
                throwIfVoiceTranscriptionAborted(signal);
                this.pendingOutcome = "optimized";
                return text;
              } catch {
                throwIfVoiceTranscriptionAborted(signal);
                this.pendingOutcome = "original-kept";
                return raw;
              } finally {
                signal.removeEventListener("abort", cancel);
              }
            },
          };
        },
      }),
      // macOS has no AVAudioSession. The private native preparation actually
      // owns permission/assets; its recorder owns format/limit on explicit record.
      configureRecording: async () => {
        if (!this.locale || !this.id) throw new Error("Voice not prepared");
      },
      releaseRecording: async () => {
        if (this.stopping) await this.stopping;
        else await this.cancelNative();
      },
      // URI is an opaque identity, not a renderer-visible file. Main has already
      // cleaned exact owned audio before stop/cancel replies can settle.
      deleteRecording: (uri) => {
        if (this.id && uri === `throughline-voice:${this.id}`) {
          this.id = null;
          this.locale = null;
          this.signal = null;
          this.stopping = null;
          this.removeAbortListener?.();
          this.removeAbortListener = null;
        }
      },
      readDraft: ports.readDraft,
      commitDraft: (text, selection) => {
        ports.commitDraft(text, selection);
        this.after = ports.readDraft();
        this.committedRaw = this.pendingRaw;
        this.committedOutcome = this.pendingOutcome;
        this.pendingRaw = null;
        this.pendingOutcome = null;
      },
      onStateChange: ports.onStateChange,
    });
  }
  private requireId(): string {
    if (!this.id) throw new Error("Voice session unavailable");
    return this.id;
  }
  private async cancelNative(id = this.id): Promise<void> {
    if (!id || id !== this.id) return;
    const preparation = this.preparation?.id === id ? this.preparation : null;
    if (preparation) preparation.abandoned = true;
    if (!this.cancelling) {
      this.cancelling = this.ports.bridge.cancel(id).then((result) => {
        if (value(result, "kind") === "error" && value(result, "code") === "stale-request") return;
        reply(result, "cancelled", id);
      });
      void this.cancelling.then(
        () =>
          preparation?.cancelled.reject(
            new VoiceTranscriptionError("cancelled", "Voice transcription was cancelled."),
          ),
        () => {
          this.cleanupFailed = true;
          preparation?.cancelled.reject(new Error("Owned voice cleanup failed"));
        },
      );
    }
    await this.cancelling;
  }
  ownerChanged(): void {
    this.cancel();
  }
  cancel(): void {
    void this.cancelNative().catch(() => {
      this.cleanupFailed = true;
    });
    this.controller.cancel();
  }
  dispose(): void {
    void this.cancelNative().catch(() => {
      this.cleanupFailed = true;
    });
    this.controller.dispose();
  }
  canUndo(): boolean {
    const current = this.ports.readDraft(),
      after = this.after;
    return (
      !!current &&
      !!after &&
      !!this.before &&
      current.ownerKey === after.ownerKey &&
      current.text === after.text &&
      current.revision === after.revision
    );
  }
  undo(): boolean {
    if (!this.canUndo() || !this.before) return false;
    this.ports.commitDraft(this.before.text, this.before.selection);
    this.after = null;
    return true;
  }
}
