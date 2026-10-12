import { describe, expect, it } from "vite-plus/test";
import {
  composerHeightBounds,
  clampComposerHeight,
  dragComposerHeight,
  DEFAULT_COMPOSER_EDITOR_HEIGHT,
} from "./composerHeight";

describe("mobile composer resize limits", () => {
  it("starts with seven readable lines instead of three", () => {
    expect(DEFAULT_COMPOSER_EDITOR_HEIGHT).toBe(170);
  });
  it("grows upward and shrinks downward without jumping at the grab", () => {
    const bounds = composerHeightBounds(800, 0, 160);
    expect(dragComposerHeight(200, 0, bounds)).toBe(200);
    expect(dragComposerHeight(200, -150, bounds)).toBe(350);
    expect(dragComposerHeight(200, 50, bounds)).toBe(150);
  });
  it("keeps the toolbar and chat header reachable at the largest size", () => {
    const bounds = composerHeightBounds(800, 0, 160);
    expect(dragComposerHeight(200, -2000, bounds)).toBe(640);
    expect(dragComposerHeight(200, 2000, bounds)).toBe(96);
  });
  it("fits above the keyboard without overwriting the remembered larger height", () => {
    const saved = 480;
    expect(clampComposerHeight(saved, composerHeightBounds(800, 320, 160))).toBe(320);
    expect(clampComposerHeight(saved, composerHeightBounds(800, 0, 160))).toBe(saved);
  });
  it("fits short landscape windows, including ones smaller than the usual minimum", () => {
    expect(composerHeightBounds(380, 240, 100)).toEqual({ min: 40, max: 40 });
  });
  it("rejects corrupt restored values rather than poisoning layout", () => {
    const bounds = composerHeightBounds(800, 0, 160);
    for (const value of [undefined, NaN, Infinity, -20])
      expect(clampComposerHeight(value, bounds)).toBe(DEFAULT_COMPOSER_EDITOR_HEIGHT);
  });
});
