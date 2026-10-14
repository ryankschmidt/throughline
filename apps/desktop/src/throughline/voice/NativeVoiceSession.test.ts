// @effect-diagnostics nodeBuiltinImport:off -- Real owned stdio-process/resource controls, not a speech-engine or mounted UI substitute.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { startNativeVoiceSession } from "./NativeVoiceSession.ts";

const fixtures: Array<{ root: string; executable: string }> = [];
function peer(mode: "normal" | "cancel" | "foreign-on-cancel") {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "voice-stdio-control-")),
  );
  const executable = NodePath.join(root, "owned-stdio-peer");
  const source = `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const directory = process.argv[3];
fs.writeFileSync(path.join(__dirname, "directory.txt"), directory);
const mode = ${JSON.stringify(mode)};
if (mode === "foreign-on-cancel") fs.writeFileSync(path.join(directory, "unexpected.txt"), "owned refusal marker");
process.stdout.write('{"event":"ready","locale":"en-US"}\\n');
let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\\n")) !== -1) {
  const command = JSON.parse(buffer.slice(0, end)).command;
  buffer = buffer.slice(end + 1);
  if (command === "record") {
    fs.writeFileSync(path.join(directory, "recording.caf"), "controlled marker; no real audio");
    process.stdout.write('{"event":"recording"}\\n');
    continue;
  }
  if (command === "stop" && mode === "normal") {
    process.stdout.write('{"event":"result","text":"Controlled fixture text, not speech proof."}\\n');
    process.exit(0); // Deliberately leave marker; parent must remove it.
  } else {
    // No sleep/polling: a wedged owned child proves emergency cleanup.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  }
});
`;
  NodeFS.writeFileSync(executable, source, { mode: 0o700 });
  fixtures.push({ root, executable });
  return {
    executable,
    readDirectory: () => NodeFS.readFileSync(NodePath.join(root, "directory.txt"), "utf8"),
  };
}
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    const metadata = NodePath.join(fixture.root, "directory.txt");
    if (NodeFS.existsSync(metadata)) {
      const directory = NodeFS.readFileSync(metadata, "utf8");
      if (NodeFS.existsSync(directory)) {
        if (!NodePath.basename(directory).startsWith("throughline-voice-"))
          throw new Error("Foreign cleanup scope");
        // Preserve the parent's refusal; clean only this test's exact marker.
        NodeFS.unlinkSync(NodePath.join(directory, "unexpected.txt"));
        NodeFS.rmdirSync(directory);
      }
      NodeFS.unlinkSync(metadata);
    }
    NodeFS.unlinkSync(fixture.executable);
    NodeFS.rmdirSync(fixture.root);
  }
});

describe("owned native stdio parent custody (no Apple capture/transcription)", () => {
  it("returns controlled text only after child exit and exact private audio cleanup", async () => {
    const fixture = peer("normal"),
      session = startNativeVoiceSession(fixture.executable);
    await session.ready;
    const directory = fixture.readDirectory();
    expect(NodeFS.statSync(directory).mode & 0o777).toBe(0o700);
    expect(NodeFS.existsSync(NodePath.join(directory, "recording.caf"))).toBe(false);
    await session.record();
    expect(NodeFS.existsSync(NodePath.join(directory, "recording.caf"))).toBe(true);
    expect(await session.stop()).toBe("Controlled fixture text, not speech proof.");
    await session.closed;
    expect(NodeFS.existsSync(directory)).toBe(false);
    expect(session.diagnosticBytes).toBe(0);
  });
  it("kills only a wedged owned child and removes its exact recording on cancel", async () => {
    const fixture = peer("cancel"),
      session = startNativeVoiceSession(fixture.executable);
    await session.ready;
    const directory = fixture.readDirectory();
    await session.record();
    await session.cancel();
    await expect(session.result).rejects.toMatchObject({ code: "cancelled" });
    expect(NodeFS.existsSync(directory)).toBe(false);
  });
  it("does not report cancellation clean when unexpected files prevent empty-directory removal", async () => {
    const fixture = peer("foreign-on-cancel"),
      session = startNativeVoiceSession(fixture.executable);
    await session.ready;
    const directory = fixture.readDirectory();
    await expect(session.cancel()).rejects.toMatchObject({ code: "cleanup-failed" });
    expect(NodeFS.existsSync(NodePath.join(directory, "recording.caf"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(directory, "unexpected.txt"))).toBe(true);
  });
});
