// @effect-diagnostics nodeBuiltinImport:off -- Finite read-only native routing guard; real controlled-speech qualification remains separate.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

describe("controlled speech never opens the real Mac microphone (source route)", () => {
  it("keeps permission/AVAudioRecorder only in the no-fixture branch and shares the analyzer", () => {
    const source = NodeFS.readFileSync(
      new URL("./native/AppleSpeechCapture.swift", import.meta.url),
      "utf8",
    );
    expect(source).toContain("if fixtureAudio == nil");
    expect(source).toContain("if let fixtureAudio");
    expect(source.match(/SpeechAnalyzer\(modules: \[transcriber\]\)/g)).toHaveLength(1);
  });
});
