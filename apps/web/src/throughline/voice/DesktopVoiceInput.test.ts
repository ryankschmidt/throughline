import { describe, expect, it } from "vite-plus/test";
import {
  DesktopVoiceInput,
  readDesktopVoicePort,
  type DesktopVoicePort,
} from "./DesktopVoiceInput";
import type { VoiceDraftSnapshot } from "@t3tools/client-runtime/voice-input";

function fixture(
  options: Partial<
    Pick<ConstructorParameters<typeof DesktopVoiceInput>[0], "request" | "getProvider">
  > = {},
) {
  const calls: string[] = [];
  let draft: VoiceDraftSnapshot = {
    ownerKey: "thread-1",
    text: "Before after",
    selection: { start: 7, end: 7 },
    revision: 0,
  };
  let completePreparation = () => {};
  const preparation = new Promise<void>((resolve) => {
    completePreparation = resolve;
  });
  const prepared = { promise: preparation, resolve: () => completePreparation() };
  const bridge: DesktopVoicePort = {
    capabilities: async () => ({ kind: "capabilities", available: true }),
    start: async (id) => {
      calls.push("prepare");
      await prepared.promise;
      return { kind: "prepared", requestId: id, locale: "en-US" };
    },
    record: async (id) => {
      calls.push(`record:${draft.text}`);
      return { kind: "started", requestId: id };
    },
    stop: async (id) => {
      calls.push("stop-cleaned");
      return { kind: "transcribed", requestId: id, text: "real port text" };
    },
    cancel: async (id) => {
      calls.push("cancel-cleaned");
      prepared.resolve();
      return { kind: "cancelled", requestId: id };
    },
  };
  let writes = 0;
  const input = new DesktopVoiceInput({
    bridge,
    readDraft: () => {
      calls.push("snapshot");
      return draft;
    },
    commitDraft: (text, selection) => {
      calls.push("commit");
      writes++;
      draft = { ...draft, text, selection, revision: draft.revision + 1 };
    },
    getProvider: () => "claude",
    request: async (raw, provider) => {
      calls.push(`optimizer:${provider}:${raw}`);
      return "optimized text";
    },
    onStateChange: (state) => {
      calls.push(state.phase);
    },
    ...options,
  });
  return {
    input,
    bridge,
    calls,
    prepared,
    get draft() {
      return draft;
    },
    get writes() {
      return writes;
    },
    mutate: () => {
      draft = { ...draft, revision: draft.revision + 1 };
    },
    switchOwner: () => {
      draft = { ...draft, ownerKey: "thread-2" };
    },
  };
}
describe("public phone controller consumes desktop native phase adapter (not speech proof)", () => {
  it("does not record during preparation; protected snapshot precedes explicit record; optimizes only after owned cleanup", async () => {
    const f = fixture();
    const start = f.input.controller.start();
    expect(f.calls.some((c) => c.startsWith("record:"))).toBe(false);
    f.prepared.resolve();
    await start;
    const record = f.calls.findIndex((c) => c.startsWith("record:"));
    expect(f.calls[record - 1]).toBe("snapshot");
    expect(f.input.controller.currentState.phase).toBe("recording");
    await f.input.controller.stop();
    expect(f.calls.indexOf("stop-cleaned")).toBeLessThan(
      f.calls.indexOf("optimizer:claude:real port text"),
    );
    expect(f.draft.text).toBe("Before optimized text after");
    expect(f.writes).toBe(1);
    expect(f.input.rawTranscript).toBe("real port text");
    expect(f.input.outcome).toBe("optimized");
    expect(f.input.undo()).toBe(true);
    expect(f.draft.text).toBe("Before after");
    expect(f.input.undo()).toBe(false);
  });
  it("cancels actual pending preparation and never records or commits late readiness", async () => {
    const f = fixture();
    const start = f.input.controller.start();
    f.input.cancel();
    await start;
    expect(f.calls).toContain("cancel-cleaned");
    expect(f.calls.some((c) => c.startsWith("record:"))).toBe(false);
    expect(f.writes).toBe(0);
  });
  it.each(["revision", "owner"])(
    "refuses a stale %s after recording without losing/replacing draft",
    async (kind) => {
      const f = fixture();
      f.prepared.resolve();
      await f.input.controller.start();
      if (kind === "revision") f.mutate();
      else f.switchOwner();
      await f.input.controller.stop();
      expect(f.writes).toBe(0);
      expect(f.draft.text).toBe("Before after");
      expect(f.input.controller.currentState.phase).toBe("error");
      expect(f.input.rawTranscript).toBeNull();
    },
  );
  it("invalidates undo on change-and-revert revision", async () => {
    const f = fixture();
    f.prepared.resolve();
    await f.input.controller.start();
    await f.input.controller.stop();
    f.mutate();
    expect(f.input.canUndo()).toBe(false);
  });
  it("does not display the prior thread's raw speech after the draft owner changes", async () => {
    const f = fixture();
    f.prepared.resolve();
    await f.input.controller.start();
    await f.input.controller.stop();
    expect(f.input.rawTranscript).toBe("real port text");
    f.switchOwner();
    f.input.controller.ownerChanged();
    expect(f.input.rawTranscript).toBeNull();
  });
  it("does not expose a partial or unsupported host bridge", () => {
    expect(readDesktopVoicePort({})).toBeNull();
    expect(readDesktopVoicePort({ throughlineVoice: { capabilities() {} } })).toBeNull();
    expect(readDesktopVoicePort({ throughlineVoice: fixture().bridge })).not.toBeNull();
  });
  it("keeps the raw insertion when the actual optimization port refuses", async () => {
    const f = fixture({
      request: async () => {
        throw new Error("Controlled optimizer refusal");
      },
    });
    f.prepared.resolve();
    await f.input.controller.start();
    await f.input.controller.stop();
    expect(f.draft.text).toBe("Before real port text after");
    expect(f.input.outcome).toBe("original-kept");
    expect(f.input.rawTranscript).toBe("real port text");
    expect(f.writes).toBe(1);
  });
  it("Off preserves raw text without invoking an optimizer", async () => {
    const f = fixture({
      getProvider: () => "off",
      request: async () => {
        throw new Error("Off must not invoke");
      },
    });
    f.prepared.resolve();
    await f.input.controller.start();
    await f.input.controller.stop();
    expect(f.draft.text).toBe("Before real port text after");
    expect(f.input.outcome).toBe("original-kept");
    expect(f.calls.some((call) => call.startsWith("optimizer:"))).toBe(false);
  });
});
