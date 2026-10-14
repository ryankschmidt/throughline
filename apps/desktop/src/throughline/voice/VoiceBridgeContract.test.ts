import { describe, expect, it } from "vite-plus/test";
import { readVoiceRequest, trustedVoiceSender } from "./VoiceBridgeContract.ts";

const id = "01234567-89ab-4def-8abc-0123456789ab";
const sender = {
  sender: { id: 17 },
  senderFrame: { parent: null, url: "t3code://app/threads/fixture" },
};
describe("local voice request and actual sender-frame boundary", () => {
  it("qualifies finite typed operation controls", () => {
    expect(readVoiceRequest({ op: "capabilities" })).toEqual({ op: "capabilities" });
    expect(readVoiceRequest({ op: "start", requestId: id })).toEqual({
      op: "start",
      requestId: id,
    });
    expect(readVoiceRequest({ op: "foreign", requestId: id })).toBeNull();
    expect(readVoiceRequest({ op: "stop" })).toBeNull();
  });
  it("refuses malformed or extra request fields without retaining them", () => {
    expect(readVoiceRequest({ op: "start", requestId: "foreign" })).toBeNull();
    expect(readVoiceRequest({ op: "start", requestId: id, path: "/foreign" })).toBeNull();
    expect(readVoiceRequest({ op: "capabilities", requestId: id })).toBeNull();
  });
  it("qualifies actual main app frame and custom development scheme", () => {
    expect(trustedVoiceSender(sender, 17, "t3code://app/")).toBe(17);
    expect(
      trustedVoiceSender(
        { ...sender, senderFrame: { parent: null, url: "t3code-dev://app/thread" } },
        17,
        "t3code-dev://app/",
      ),
    ).toBe(17);
    expect(trustedVoiceSender(sender, 99, "t3code://app/")).toBeNull();
  });
  it.each([
    ["missing frame", { sender: { id: 17 } }],
    ["iframe", { ...sender, senderFrame: { parent: {}, url: "t3code://app/" } }],
    ["external page", { ...sender, senderFrame: { parent: null, url: "https://example.com/" } }],
    ["other custom scheme", { ...sender, senderFrame: { parent: null, url: "t3code-dev://app/" } }],
    ["wrong host", { ...sender, senderFrame: { parent: null, url: "t3code://foreign/" } }],
    ["opaque origin", { ...sender, senderFrame: { parent: null, url: "about:blank" } }],
  ])("refuses %s even with main webContents ID", (_name, bad) => {
    expect(trustedVoiceSender(bad, 17, "t3code://app/")).toBeNull();
  });
});
