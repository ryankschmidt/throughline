// @effect-diagnostics nodeBuiltinImport:off -- Private native child stdio has no Effect binding; follows NativeCaptureFeedback's owned-child pattern.
// @effect-diagnostics globalTimers:off -- One cancellation deadline kills only this owned child; not polling or readiness by elapsed time.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { NativeVoiceProtocol, type NativeVoiceEvent } from "./NativeVoiceProtocol.ts";

type Failure =
  | Extract<NativeVoiceEvent, { event: "error" }>["code"]
  | "cancelled"
  | "protocol-refused"
  | "helper-failed"
  | "cleanup-failed";

export class NativeVoiceFailure extends Error {
  readonly code: Failure;
  constructor(code: Failure) {
    super(`Desktop dictation ${code}`);
    this.code = code;
  }
}

/** Main-process only. Executable comes from the owning resource resolver,
 * never a renderer/RPC/settings path. No shell, provider, or transcript log.
 * Parent custody also removes the exact audio file on forced child exit.
 */
export type ControlledVoiceFile = { readonly directory: string; readonly sha256: string };
export function startNativeVoiceSession(executable: string, fixtureInput?: ControlledVoiceFile) {
  if (!NodePath.isAbsolute(executable)) throw new Error("Native voice resource must be absolute");
  let fixtureFile: string | undefined;
  if (fixtureInput) {
    const root = fixtureInput.directory;
    if (
      !NodePath.isAbsolute(root) ||
      !NodePath.basename(root).startsWith("throughline-voice-input-") ||
      NodeFS.realpathSync(root) !== root ||
      (NodeFS.statSync(root).mode & 0o777) !== 0o700
    )
      throw new Error("Controlled voice input custody refused");
    const file = NodePath.join(root, "input.caf");
    const stat = NodeFS.lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 16 * 1024 * 1024 ||
      !/^[0-9a-f]{64}$/.test(fixtureInput.sha256) ||
      NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex") !==
        fixtureInput.sha256
    )
      throw new Error("Controlled voice input hash refused");
    fixtureFile = file;
  }
  const directory = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "throughline-voice-")),
  );
  NodeFS.chmodSync(directory, 0o700);
  const removeOwnedAudio = () => {
    const missing = (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "ENOENT";
    try {
      NodeFS.unlinkSync(NodePath.join(directory, "recording.caf"));
    } catch (error) {
      if (!missing(error)) throw error;
    }
    // Refuse unexpected contents; never recursively delete an arbitrary tree.
    try {
      NodeFS.rmdirSync(directory);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  };
  const launch = () => {
    try {
      return NodeChildProcess.spawn(
        executable,
        fixtureFile ? ["fixture-file", directory, fixtureFile] : ["capture", directory],
        {
          stdio: ["pipe", "pipe", "pipe"],
          // No inherited provider configuration, auth environment or executable PATH.
          env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
          cwd: directory,
        },
      );
    } catch {
      try {
        removeOwnedAudio();
      } catch {
        throw new NativeVoiceFailure("cleanup-failed");
      }
      throw new NativeVoiceFailure("helper-failed");
    }
  };
  const child = launch();
  const protocol = new NativeVoiceProtocol();
  const ready = Promise.withResolvers<{ readonly locale: string }>();
  const recorded = Promise.withResolvers<void>();
  const result = Promise.withResolvers<string>();
  const exited = Promise.withResolvers<void>();
  const cleaned = Promise.withResolvers<void>();
  // A prepare failure can arrive before the renderer awaits a stop/result.
  // Keep the actual rejecting promises, but prevent ambient unhandled logs.
  void ready.promise.catch(() => {});
  void recorded.promise.catch(() => {});
  void result.promise.catch(() => {});
  void cleaned.promise.catch(() => {});
  let closed = false;
  let cancelling = false;
  let recordRequested = false;
  let buffer = "";
  let text: string | undefined;
  let failure: NativeVoiceFailure | undefined;
  let diagnosticBytes = 0;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  const cancelChild = () => {
    if (closed || cancelling) return;
    cancelling = true;
    child.stdin.end('{"command":"cancel"}\n');
    killTimer = setTimeout(() => {
      if (!closed) child.kill("SIGKILL");
    }, 1000);
    killTimer.unref();
  };
  const refuse = (code: Failure) => {
    failure ??= new NativeVoiceFailure(code);
    ready.reject(failure);
    recorded.reject(failure);
    result.reject(failure);
    cancelChild();
  };
  child.stdin.on("error", () => refuse("helper-failed"));
  child.once("error", () => refuse("helper-failed"));
  child.stderr.on("data", (chunk: Buffer) => {
    diagnosticBytes += chunk.length;
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 262_144) {
      refuse("protocol-refused");
      return;
    }
    let end: number;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const event = protocol.accept(line);
        switch (event.event) {
          case "ready":
            ready.resolve({ locale: event.locale });
            break;
          case "recording":
            recorded.resolve();
            break;
          case "result":
            text = event.text;
            break;
          case "error":
            refuse(event.code);
            break;
          case "cancelled":
            refuse("cancelled");
            break;
        }
      } catch {
        refuse("protocol-refused");
      }
    }
  });
  child.once("close", (code, signal) => {
    closed = true;
    if (killTimer) clearTimeout(killTimer);
    if (buffer.length > 0) failure ??= new NativeVoiceFailure("protocol-refused");
    if (code !== 0 || signal !== null) failure ??= new NativeVoiceFailure("helper-failed");
    if (protocol.phase !== "completed" || text === undefined)
      failure ??= new NativeVoiceFailure("helper-failed");
    try {
      removeOwnedAudio();
      cleaned.resolve();
    } catch {
      const cleanupFailure = new NativeVoiceFailure("cleanup-failed");
      failure ??= cleanupFailure;
      cleaned.reject(cleanupFailure);
    }
    if (failure) {
      ready.reject(failure);
      recorded.reject(failure);
      result.reject(failure);
    } else if (text !== undefined) result.resolve(text);
    // Raw text remains private to the result promise, not a lifetime log.
    text = undefined;
    buffer = "";
    exited.resolve();
  });
  return {
    ready: ready.promise,
    result: result.promise,
    closed: exited.promise,
    cleaned: cleaned.promise,
    get diagnosticBytes() {
      return diagnosticBytes;
    },
    record() {
      if (closed || failure) throw failure ?? new NativeVoiceFailure("helper-failed");
      if (recordRequested) return recorded.promise;
      protocol.record();
      recordRequested = true;
      child.stdin.write('{"command":"record"}\n');
      return recorded.promise;
    },
    async stop() {
      if (!recordRequested) throw new NativeVoiceFailure("recording-failed");
      await recorded.promise;
      if (closed || failure) throw failure ?? new NativeVoiceFailure("helper-failed");
      protocol.stop();
      child.stdin.write('{"command":"stop"}\n');
      return result.promise;
    },
    async cancel() {
      if (!closed) {
        protocol.cancel();
        refuse("cancelled");
      }
      await exited.promise;
      await cleaned.promise;
    },
  };
}
