import { describe, expect, it } from "vite-plus/test";
import {
  addAudioToGeneratedEntitlements,
  MAC_VOICE_EXTRA_RESOURCES,
  VOICE_USAGE_DESCRIPTIONS,
} from "./VoiceBuildAdapter.ts";

describe("Mac voice packaging authority boundary", () => {
  it("adds only audio input to the controlled generated root dictionary", () => {
    const original =
      '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>keychain-access-groups</key><array><string>public-group-id</string></array></dict></plist>';
    const result = addAudioToGeneratedEntitlements(original);
    expect(result).toContain("<key>com.apple.security.device.audio-input</key>");
    expect(result).toContain(
      "<key>keychain-access-groups</key><array><string>public-group-id</string></array>",
    );
    expect(result).toContain("<key>com.apple.security.cs.allow-jit</key><true/>");
    expect(addAudioToGeneratedEntitlements(result)).toBe(result);
  });
  it("corrects an explicit false audio flag without adding a duplicate or changing other keys", () => {
    const original =
      '<plist version="1.0"><dict><key>com.apple.security.device.audio-input</key><false/><key>existing</key><true/></dict></plist>';
    const result = addAudioToGeneratedEntitlements(original);
    expect(result).toContain("<key>com.apple.security.device.audio-input</key><true/>");
    expect(result.match(/<key>com.apple.security.device.audio-input<\/key>/g)).toHaveLength(1);
    expect(result).toContain("<key>existing</key><true/>");
  });
  it("refuses unsupported/malformed/duplicate dictionaries before signing", () => {
    for (const xml of [
      "not xml",
      "<plist><dict><dict></dict></dict></plist>",
      "<plist><dict><key>com.apple.security.device.audio-input</key><true/><key>com.apple.security.device.audio-input</key><false/></dict></plist>",
    ]) {
      expect(() => addAudioToGeneratedEntitlements(xml)).toThrow();
    }
  });
  it("packages just the fixed helper/preload and declares both usage descriptions", () => {
    expect(MAC_VOICE_EXTRA_RESOURCES.map((x) => x.to)).toEqual([
      "throughline-apple-speech",
      "throughline-voice-preload.cjs",
    ]);
    expect(VOICE_USAGE_DESCRIPTIONS.NSMicrophoneUsageDescription).toContain("dictation");
    expect(VOICE_USAGE_DESCRIPTIONS.NSSpeechRecognitionUsageDescription).toContain("Apple Speech");
  });
});
