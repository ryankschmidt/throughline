import { describe, expect, it } from "vite-plus/test";

import { compactThreadTitleWidth } from "./threadHeaderLayout";

describe("compactThreadTitleWidth", () => {
  it("gives the title the room left by the back button, thread menu and three trailing buttons", () => {
    // iPhone 17 Pro: 402 - 32 margins - 5 slots of 52 = 110.
    expect(
      compactThreadTitleWidth({ windowWidth: 402, leadingButtons: 1, trailingButtons: 3 }),
    ).toBe(110);
  });

  it("never shrinks below the old 72-point title or grows past a readable cap", () => {
    expect(
      compactThreadTitleWidth({ windowWidth: 320, leadingButtons: 2, trailingButtons: 4 }),
    ).toBe(72);
    expect(
      compactThreadTitleWidth({ windowWidth: 1024, leadingButtons: 1, trailingButtons: 3 }),
    ).toBe(260);
  });
});
