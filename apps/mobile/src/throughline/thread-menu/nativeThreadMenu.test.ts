import { describe, expect, it } from "vite-plus/test";
import {
  buildThreadActionMenuItems,
  type ThreadActionMenuState,
} from "../../../../web/src/components/threadActionMenu.logic";
import { nativeThreadMenuActions, iosThreadMenuItems } from "./nativeThreadMenu";
const state: ThreadActionMenuState = {
  canOperate: true,
  branch: "work",
  sessionUuid: "native-uuid",
  transcriptPath: null,
  projectFilter: { label: "Project", isActive: false },
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [],
};
describe("desktop-native thread menu parity", () => {
  it("retains every desktop label/order and nested copy identity without inventing a transcript", () => {
    const desktop = buildThreadActionMenuItems(state);
    const native = nativeThreadMenuActions(desktop);
    expect(native.map((i) => i.title)).toEqual(desktop.map((i) => i.label));
    expect(native.find((i) => i.id === "copy")?.subactions?.map((i) => [i.id, i.title])).toEqual([
      ["copy-path", "Path"],
      ["copy-branch", "Branch"],
      ["copy-thread-id", "Thread ID"],
      ["copy-session-uuid", "Session UUID"],
    ]);
  });
  it("preserves read-only refusals recursively and running archive refusal", () => {
    const native = nativeThreadMenuActions(
      buildThreadActionMenuItems({ ...state, canOperate: false, isRunning: true }),
    );
    expect(native.find((i) => i.id === "delete")?.attributes?.disabled).toBe(true);
    expect(native.find((i) => i.id === "copy")?.attributes?.disabled).not.toBe(true);
    expect(
      native.find((i) => i.id === "auto-settle")?.subactions?.every((i) => i.attributes?.disabled),
    ).toBe(true);
    expect(native.find((i) => i.id === "archive")?.attributes?.disabled).toBe(true);
  });
  it("keeps checked settings and destructive flags without replacing labels", () => {
    const native = nativeThreadMenuActions(buildThreadActionMenuItems(state));
    expect(native.find((i) => i.id === "auto-settle")?.subactions?.map((i) => i.state)).toEqual([
      "on",
      "off",
    ]);
    expect(native.find((i) => i.id === "delete")?.attributes?.destructive).toBe(true);
  });
  it("serializes iOS nested actions with the same labels and selected command", () => {
    const ids: string[] = [];
    const items = iosThreadMenuItems(buildThreadActionMenuItems(state), (id) => ids.push(id));
    expect(items.map((i) => i.label)).toEqual(
      buildThreadActionMenuItems(state).map((i) => i.label),
    );
    const copy = items.find((i) => i.label === "Copy")!;
    const children = (copy as { items: { label: string; onPress: () => void }[] }).items;
    children.find((i) => i.label === "Session UUID")!.onPress();
    expect(ids).toEqual(["copy-session-uuid"]);
  });
});
