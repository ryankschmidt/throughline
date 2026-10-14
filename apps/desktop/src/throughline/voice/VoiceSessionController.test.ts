import { describe, expect, it } from "vite-plus/test";
import { NativeVoiceFailure, type startNativeVoiceSession } from "./NativeVoiceSession.ts";
import { VoiceSessionController } from "./VoiceSessionController.ts";

const id = "01234567-89ab-4def-8abc-0123456789ab";
const newer = "11234567-89ab-4def-8abc-0123456789ab";
// Typed port sequencing only; not an Apple engine or mounted IPC substitute.
function sessionPort() {
  const ready = Promise.withResolvers<{ readonly locale: string }>(),
    result = Promise.withResolvers<string>();
  const closed = Promise.withResolvers<void>(),
    cleaned = Promise.withResolvers<void>();
  void ready.promise.catch(() => {});
  void result.promise.catch(() => {});
  let cancels = 0;
  const session: ReturnType<typeof startNativeVoiceSession> = {
    ready: ready.promise,
    result: result.promise,
    closed: closed.promise,
    cleaned: cleaned.promise,
    diagnosticBytes: 0,
    record: async () => {},
    stop: () => {
      result.resolve("Typed fixture transcript");
      cleaned.resolve();
      closed.resolve();
      return result.promise;
    },
    cancel: async () => {
      cancels++;
      ready.reject(new NativeVoiceFailure("cancelled"));
      result.reject(new NativeVoiceFailure("cancelled"));
      cleaned.resolve();
      closed.resolve();
    },
  };
  return {
    session,
    ready,
    get cancels() {
      return cancels;
    },
  };
}

describe("private voice controller window/request identity", () => {
  it("leaves disabled capabilities cold without constructing a native child", async () => {
    let starts = 0;
    const controller = new VoiceSessionController(false, () => {
      starts++;
      return sessionPort().session;
    });
    expect(await controller.invoke(17, { op: "capabilities" })).toEqual({
      kind: "capabilities",
      available: false,
    });
    expect(await controller.invoke(17, { op: "start", requestId: id })).toEqual({
      kind: "error",
      code: "unavailable",
    });
    expect(starts).toBe(0);
  });
  it("holds one child while preparing, replays only the same request and preserves transcript after stop", async () => {
    const port = sessionPort();
    let starts = 0;
    const controller = new VoiceSessionController(true, () => {
      starts++;
      return port.session;
    });
    const first = controller.invoke(17, { op: "start", requestId: id });
    const replay = controller.invoke(17, { op: "start", requestId: id });
    expect(await controller.invoke(18, { op: "start", requestId: newer })).toEqual({
      kind: "error",
      code: "busy",
    });
    expect(starts).toBe(1);
    port.ready.resolve({ locale: "en-US" });
    expect(await first).toEqual({ kind: "prepared", requestId: id, locale: "en-US" });
    expect(await replay).toEqual({ kind: "prepared", requestId: id, locale: "en-US" });
    expect(await controller.invoke(17, { op: "stop", requestId: id })).toEqual({
      kind: "transcribed",
      requestId: id,
      text: "Typed fixture transcript",
    });
    expect(await controller.invoke(17, { op: "stop", requestId: id })).toEqual({
      kind: "error",
      code: "stale-request",
    });
  });
  it("refuses foreign/stale cancellation and closes only the owning window", async () => {
    const port = sessionPort(),
      controller = new VoiceSessionController(true, () => port.session);
    port.ready.resolve({ locale: "en-US" });
    await controller.invoke(17, { op: "start", requestId: id });
    expect(await controller.invoke(18, { op: "cancel", requestId: id })).toEqual({
      kind: "error",
      code: "stale-request",
    });
    expect(await controller.invoke(17, { op: "cancel", requestId: newer })).toEqual({
      kind: "error",
      code: "stale-request",
    });
    await controller.closeOwner(18);
    expect(port.cancels).toBe(0);
    await controller.closeOwner(17);
    expect(port.cancels).toBe(1);
  });
  it("allows cancellation while native preparation is pending without a late start response", async () => {
    const port = sessionPort(),
      controller = new VoiceSessionController(true, () => port.session);
    const start = controller.invoke(17, { op: "start", requestId: id });
    expect(await controller.invoke(17, { op: "cancel", requestId: id })).toEqual({
      kind: "cancelled",
      requestId: id,
    });
    expect(await start).toEqual({ kind: "error", code: "cancelled" });
  });
});
