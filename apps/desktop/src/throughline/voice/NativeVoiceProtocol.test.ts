import { describe, expect, it } from "vite-plus/test";
import { NativeVoiceProtocol } from "./NativeVoiceProtocol.ts";

describe("private native voice stdio lifecycle", () => {
  it("preparation acknowledgement cannot start audio before protected draft capture", () => {
    const session = new NativeVoiceProtocol();
    session.accept('{"event":"ready","locale":"en-US"}');
    expect(session.phase).toBe("prepared");
    expect(() => session.stop()).toThrow("Voice session is not capturing");
  });
  it("acknowledges capture, accepts transcript only after stop, then refuses replay", () => {
    const session = new NativeVoiceProtocol();
    expect(session.accept('{"event":"ready","locale":"en-US"}')).toEqual({
      event: "ready",
      locale: "en-US",
    });
    expect(session.phase).toBe("prepared");
    session.record();
    session.accept('{"event":"recording"}');
    expect(session.phase).toBe("capturing");
    session.stop();
    const text = "Fixture speech stays editable.\nSecond sentence.";
    expect(session.accept(JSON.stringify({ event: "result", text }))).toEqual({
      event: "result",
      text,
    });
    expect(session.phase).toBe("completed");
    expect(() => session.accept('{"event":"result","text":"duplicate"}')).toThrow();
  });
  it("refuses premature result/stop and duplicate readiness", () => {
    const session = new NativeVoiceProtocol();
    expect(() => session.stop()).toThrow();
    expect(() => session.accept('{"event":"result","text":"premature"}')).toThrow();
    session.accept('{"event":"ready","locale":"en-US"}');
    expect(() => session.accept('{"event":"ready","locale":"en-US"}')).toThrow();
  });
  it("cancels during preparation without a late ready/result resurrecting capture", () => {
    const session = new NativeVoiceProtocol();
    session.cancel();
    expect(() => session.accept('{"event":"ready","locale":"en-US"}')).toThrow();
    expect(() => session.accept('{"event":"result","text":"late"}')).toThrow();
    session.accept('{"event":"cancelled"}');
    expect(session.phase).toBe("cancelled");
  });
  it("cancels after stop and refuses late transcription", () => {
    const session = new NativeVoiceProtocol();
    session.accept('{"event":"ready","locale":"en-US"}');
    session.record();
    session.accept('{"event":"recording"}');
    session.stop();
    session.cancel();
    session.accept('{"event":"cancelled"}');
    expect(() => session.accept('{"event":"result","text":"late"}')).toThrow();
  });
  it("only forwards finite native error codes and seals the failed session", () => {
    const session = new NativeVoiceProtocol();
    expect(session.accept('{"event":"error","code":"permission-denied"}')).toEqual({
      event: "error",
      code: "permission-denied",
    });
    expect(session.phase).toBe("failed");
    expect(() => session.accept('{"event":"ready","locale":"en-US"}')).toThrow();
    expect(() =>
      new NativeVoiceProtocol().accept('{"event":"error","code":"foreign diagnostic"}'),
    ).toThrow();
  });
  it("refuses extra fields, wrong shapes and oversized input without exporting their bytes", () => {
    for (const line of [
      "null",
      "[]",
      '{"event":"ready","locale":"en-US","extra":"private"}',
      '{"event":"result","text":1}',
      '{"event":"unknown"}',
      "x".repeat(262_145),
    ]) {
      expect(() => new NativeVoiceProtocol().accept(line)).toThrow();
    }
  });
  it("sanitizes decoder diagnostics and keeps terminal disposal idempotent", () => {
    const privateValue = "owned-fixture-private-value";
    for (const line of [privateValue, JSON.stringify({ event: "error", code: privateValue })]) {
      try {
        new NativeVoiceProtocol().accept(line);
        throw new Error("Expected native protocol refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        if (!(error instanceof Error)) throw error;
        expect(error.message).toBe("Invalid private voice protocol message");
        expect(error.message).not.toContain(privateValue);
      }
    }
    const session = new NativeVoiceProtocol();
    session.accept('{"event":"error","code":"permission-denied"}');
    session.cancel();
    expect(session.phase).toBe("failed");
  });
});
