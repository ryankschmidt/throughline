import { describe, expect, it } from "vite-plus/test";
import { OptimizationCapture } from "./optimizationCapture";

function harness(initial = "before") {
  let text = initial;
  const listeners = new Set<() => void>();
  const capture = new OptimizationCapture(
    "owner",
    () => text,
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  );
  const write = (value: string) => {
    text = value;
    for (const listener of [...listeners]) listener();
  };
  return { capture, write, read: () => text, listenerCount: () => listeners.size };
}

describe("global-session voice optimization receipt", () => {
  it("publishes raw only on committed dictation and undoes without a second transcription", async () => {
    const h = harness();
    const wrapped = h.capture.wrap(
      { prepare: async () => ({ locale: "en", transcribe: async () => "raw words" }) },
      () => "claude",
      async () => new Response(JSON.stringify({ optimized: "Clean words." })),
    );
    const prepared = await wrapped.prepare({ signal: new AbortController().signal });
    const text = await prepared.transcribe("fixture.m4a", { signal: new AbortController().signal });
    expect(h.capture.rawTranscript).toBeNull();
    h.capture.commit(text, { start: 0, end: 6 }, () => h.write(text));
    expect(h.capture.rawTranscript).toBe("raw words");
    expect(h.capture.result?.outcome).toBe("optimized");
    const restored = h.capture.restore({ start: text.length, end: text.length });
    expect(restored?.text).toBe("before");
    expect(h.listenerCount()).toBe(0);
  });

  it("does not overwrite later typing even when it changes back to the optimized text", async () => {
    const h = harness();
    const wrapped = h.capture.wrap(
      { prepare: async () => ({ locale: "en", transcribe: async () => "raw" }) },
      () => "off",
      async () => {
        throw new Error("Off must not fetch");
      },
    );
    const prepared = await wrapped.prepare({ signal: new AbortController().signal });
    const text = await prepared.transcribe("fixture.m4a", { signal: new AbortController().signal });
    h.capture.commit(text, { start: 0, end: 6 }, () => h.write(text));
    expect(h.capture.canUndo({ start: 3, end: 3 })).toBe(true);
    h.write("later typing");
    h.write(text);
    expect(h.capture.restore({ start: 3, end: 3 })).toBeNull();
    expect(h.read()).toBe("raw");
  });

  it("cancellation leaves no raw text or success receipt and detaches its draft listener", async () => {
    const h = harness();
    const wrapped = h.capture.wrap(
      { prepare: async () => ({ locale: "en", transcribe: async () => "raw" }) },
      () => "off",
      async () => {
        throw new Error("Off must not fetch");
      },
    );
    const prepared = await wrapped.prepare({ signal: new AbortController().signal });
    await prepared.transcribe("fixture.m4a", { signal: new AbortController().signal });
    h.capture.settled();
    expect(h.capture.rawTranscript).toBeNull();
    expect(h.capture.result).toBeNull();
    expect(h.capture.canUndo({ start: 0, end: 0 })).toBe(false);
    expect(h.listenerCount()).toBe(0);
  });

  it("clears optimization feedback after the draft is sent while retaining the raw copy", async () => {
    const h = harness();
    const wrapped = h.capture.wrap(
      { prepare: async () => ({ locale: "en", transcribe: async () => "raw" }) },
      () => "off",
      async () => {
        throw new Error("Off must not fetch");
      },
    );
    const prepared = await wrapped.prepare({ signal: new AbortController().signal });
    const text = await prepared.transcribe("fixture.m4a", { signal: new AbortController().signal });
    h.capture.commit(text, { start: 0, end: 6 }, () => h.write(text));
    h.write("");
    expect(h.capture.result).toBeNull();
    expect(h.capture.rawTranscript).toBe("raw");
    expect(h.capture.canUndo({ start: 0, end: 0 })).toBe(false);
  });
});
