import {
  type VoiceInputController,
  type VoiceTranscriber,
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
} from "@t3tools/client-runtime/voice-input";

interface AppLifecycle {
  readonly currentState: string | null | undefined;
  addEventListener(event: "change", listener: (state: string) => void): { remove(): void };
}

const guards = new WeakMap<VoiceInputController, AndroidPreparationGuard>();

/** Decorate this session's public boundary, never the controller prototype or another session. */
class AndroidPreparationGuard {
  private generation = 0;
  private nativePreparation = false;
  constructor(controller: VoiceInputController) {
    const background = controller.appMovedToBackground.bind(controller);
    controller.appMovedToBackground = () => {
      if (this.nativePreparation && controller.currentState.phase === "preparing") return;
      return background();
    };
  }
  arm() {
    this.nativePreparation = true;
    return ++this.generation;
  }
  disarm(generation: number) {
    if (generation === this.generation) this.nativePreparation = false;
  }
}

function waitForForeground(app: AppLifecycle, signal: AbortSignal): Promise<void> {
  throwIfVoiceTranscriptionAborted(signal);
  if (app.currentState === "active") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (cancelled: boolean) => {
      subscription.remove();
      signal.removeEventListener("abort", abort);
      if (cancelled)
        reject(new VoiceTranscriptionError("cancelled", "Voice preparation was cancelled."));
      else resolve();
    };
    const abort = () => finish(true);
    const subscription = app.addEventListener("change", (state) => {
      if (state === "active") finish(false);
    });
    signal.addEventListener("abort", abort, { once: true });
    // A transition may occur while the listener is being installed.
    if (signal.aborted) finish(true);
    else if (app.currentState === "active") finish(false);
  });
}

/** Android permission activities may background preparation, not an actual recording. */
export function withAndroidPreparationLifecycle(
  controller: VoiceInputController,
  transcriber: VoiceTranscriber,
  platform: string,
  app: AppLifecycle,
): VoiceTranscriber {
  if (platform !== "android") return transcriber;
  let guard = guards.get(controller);
  if (!guard) {
    guard = new AndroidPreparationGuard(controller);
    guards.set(controller, guard);
  }
  // The controller requests microphone permission before it invokes prepare.
  const generation = guard.arm();
  const preparation = guard;
  return {
    prepare: async (options) => {
      try {
        const prepared = await transcriber.prepare(options);
        await waitForForeground(app, options.signal);
        return prepared;
      } finally {
        // Later preparation/recording transitions use normal background cancellation.
        preparation.disarm(generation);
      }
    },
  };
}
