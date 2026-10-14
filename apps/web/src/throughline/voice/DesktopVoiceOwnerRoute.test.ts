// @effect-diagnostics nodeBuiltinImport:off -- Finite actual hook-caller source binding and typed external bridge controls; no native/React-mounted acceptance.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { DesktopVoiceInput, type DesktopVoicePort } from "./DesktopVoiceInput";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
const hook = NodeFS.readFileSync(new URL("./useDesktopVoiceInput.ts", import.meta.url), "utf8");
function actualOwnerChange(input: DesktopVoiceInput) {
  const matches = [
    ...hook.matchAll(
      /useLayoutEffect\(\(\) => \{\s*(input\.current\?\.(?:controller\.)?ownerChanged\(\);)\s*\}, \[ports\.ownerKey\]\)/g,
    ),
  ];
  if (matches.length !== 1) throw new Error("Actual owner effect is missing/ambiguous/unsupported");
  const path = matches[0]![1];
  if (path === "input.current?.controller.ownerChanged();") return input.controller.ownerChanged();
  if (path !== "input.current?.ownerChanged();") throw new Error("Unsupported owner effect");
  const method: unknown = Reflect.get(input, "ownerChanged");
  if (typeof method !== "function") throw new Error("Actual owning method absent");
  return method.call(input);
}
function fixture() {
  type Slot = {
    id: string;
    ready: ReturnType<typeof deferred<void>>;
    clean: ReturnType<typeof deferred<void>>;
  };
  const slots: Slot[] = [],
    cancels: string[] = [],
    records: string[] = [],
    stops: string[] = [];
  const secondStart = deferred<Slot>();
  let active: Slot | null = null,
    owner = "A",
    writes = 0;
  const bridge: DesktopVoicePort = {
    capabilities: async () => ({ kind: "capabilities", available: true }),
    start: async (id) => {
      let slot = slots.find((s) => s.id === id);
      if (!slot) {
        if (active) return { kind: "error", code: "busy" };
        slot = { id, ready: deferred<void>(), clean: deferred<void>() };
        slots.push(slot);
        active = slot;
        if (slots.length === 2) secondStart.resolve(slot);
      }
      await slot.ready.promise;
      // Delayed delivery of an earlier prepared reply may follow cancel ACK.
      return { kind: "prepared", requestId: id, locale: "en-US" };
    },
    cancel: async (id) => {
      cancels.push(id);
      const slot = slots.find((s) => s.id === id);
      if (slot) await slot.clean.promise;
      if (active?.id === id) active = null;
      return { kind: "cancelled", requestId: id };
    },
    record: async (id) => {
      records.push(id);
      return { kind: "started", requestId: id };
    },
    stop: async (id) => {
      stops.push(id);
      if (active?.id === id) active = null;
      return { kind: "transcribed", requestId: id, text: "Owned controlled transcript" };
    },
  };
  const input = new DesktopVoiceInput({
    bridge,
    getProvider: () => "off",
    onStateChange: () => {},
    readDraft: () => ({ ownerKey: owner, text: "", selection: { start: 0, end: 0 }, revision: 0 }),
    commitDraft: () => {
      writes++;
    },
  });
  return {
    input,
    slots,
    cancels,
    records,
    stops,
    secondStart,
    get writes() {
      return writes;
    },
    changeOwner: () => {
      owner = "B";
      actualOwnerChange(input);
    },
    cleanup: async (pending: Promise<void>) => {
      for (const slot of slots) {
        slot.ready.resolve();
        slot.clean.resolve();
      }
      const stop = input.controller.stop();
      input.dispose();
      await pending;
      await stop;
    },
  };
}
describe("exact hook owner-change route during pending native preparation", () => {
  it("sends owning native cancel while bridge.start is still pending, not only JS invalidation", async () => {
    const f = fixture(),
      pending = f.input.controller.start();
    try {
      expect(f.slots).toHaveLength(1);
      f.changeOwner();
      expect(f.cancels).toEqual([f.slots[0]!.id]);
      expect(f.records).toEqual([]);
      expect(f.writes).toBe(0);
    } finally {
      await f.cleanup(pending);
    }
  });
  it("waits for owning cleanup, then lets B start before A's late ready; A cannot erase B's request ID", async () => {
    const f = fixture(),
      pendingA = f.input.controller.start();
    let pendingB = Promise.resolve();
    try {
      const a = f.slots[0]!;
      f.changeOwner();
      expect(f.cancels).toEqual([a.id]);
      pendingB = f.input.controller.start();
      await Promise.resolve();
      expect(f.slots).toHaveLength(1);
      a.clean.resolve();
      await pendingA;
      const b = await Promise.race([
        f.secondStart.promise,
        pendingB.then(() => {
          const slot = f.slots[1];
          if (!slot) throw new Error("Next owner failed before native slot acquisition");
          return slot;
        }),
      ]);
      b.ready.resolve();
      await pendingB;
      expect(f.input.controller.currentState.phase).toBe("recording");
      a.ready.resolve();
      await a.ready.promise;
      await Promise.resolve();
      expect(f.records).toEqual([b.id]);
      await f.input.controller.stop();
      expect(f.stops).toEqual([b.id]);
      expect(f.writes).toBe(1);
    } finally {
      await f.cleanup(pendingA);
      await pendingB;
    }
  });
  it.each(["cancel", "dispose", "background"])(
    "%s also releases pending preparation after native cleanup, without late recording",
    async (route) => {
      const f = fixture(),
        pending = f.input.controller.start();
      try {
        if (route === "background") {
          const body = hook.slice(
            hook.indexOf("const background ="),
            hook.indexOf('document.addEventListener("visibilitychange"'),
          );
          expect(body).toContain("if (document.hidden) input.current?.cancel();");
          f.input.cancel();
        } else if (route === "dispose") {
          expect(hook).toContain("input.current?.dispose();");
          f.input.dispose();
        } else f.input.cancel();
        expect(f.cancels).toEqual([f.slots[0]!.id]);
        f.slots[0]!.clean.resolve();
        await pending;
        f.slots[0]!.ready.resolve();
        await Promise.resolve();
        expect(f.records).toEqual([]);
        expect(f.writes).toBe(0);
      } finally {
        await f.cleanup(pending);
      }
    },
  );
});
