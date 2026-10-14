import { NativeVoiceFailure, type startNativeVoiceSession } from "./NativeVoiceSession.ts";
import type { VoiceReply, VoiceRequest } from "./VoiceBridgeContract.ts";

type NativeSession = ReturnType<typeof startNativeVoiceSession>;
type Slot = { readonly owner: number; readonly requestId: string; readonly session: NativeSession };

/** One native utterance across app windows; a stale composer cannot stop a
 * newer request. The main layer supplies a qualified, fixed executable port.
 */
export class VoiceSessionController {
  private active: Slot | null = null;
  private readonly available: boolean;
  private readonly start: () => NativeSession;
  constructor(available: boolean, start: () => NativeSession) {
    this.available = available;
    this.start = start;
  }

  async invoke(owner: number, request: VoiceRequest): Promise<VoiceReply> {
    if (request.op === "capabilities") return { kind: "capabilities", available: this.available };
    if (!this.available) return { kind: "error", code: "unavailable" };
    try {
      if (request.op === "start") {
        if (
          this.active &&
          (this.active.owner !== owner || this.active.requestId !== request.requestId)
        )
          return { kind: "error", code: "busy" };
        const slot = this.active ?? { owner, requestId: request.requestId, session: this.start() };
        this.active = slot;
        void slot.session.closed.then(() => {
          if (this.active === slot) this.active = null;
        });
        const prepared = await slot.session.ready;
        if (this.active !== slot) return { kind: "error", code: "cancelled" };
        return { kind: "prepared", requestId: request.requestId, locale: prepared.locale };
      }
      const slot = this.active;
      if (!slot || slot.owner !== owner || slot.requestId !== request.requestId)
        return { kind: "error", code: "stale-request" };
      if (request.op === "cancel") {
        await slot.session.cancel();
        return { kind: "cancelled", requestId: request.requestId };
      }
      if (request.op === "record") {
        await slot.session.record();
        if (this.active !== slot) return { kind: "error", code: "cancelled" };
        return { kind: "started", requestId: request.requestId };
      }
      const text = await slot.session.stop();
      await slot.session.cleaned;
      return { kind: "transcribed", requestId: request.requestId, text };
    } catch (cause) {
      return {
        kind: "error",
        code: cause instanceof NativeVoiceFailure ? cause.code : "helper-failed",
      };
    }
  }
  async closeOwner(owner?: number): Promise<void> {
    const slot = this.active;
    if (slot && (owner === undefined || owner === slot.owner)) await slot.session.cancel();
  }
}
