// @effect-diagnostics nodeBuiltinImport:off -- Read-only private native qualification; no shell or captured transcript.
import * as NodeChildProcess from "node:child_process";
import * as Schema from "effect/Schema";

const Qualification = Schema.Struct({
  schema: Schema.Literal("throughline.desktop-voice-qualification.v1"),
  engine: Schema.Literal("apple-speech-analyzer"),
  available: Schema.Boolean,
  assets: Schema.Literals([
    "installed",
    "supported",
    "downloading",
    "unsupported",
    "unknown",
    "not_checked",
  ]),
  locale: Schema.NullOr(Schema.String),
  captureStarted: Schema.Literal(false),
  assetInstallRequested: Schema.Literal(false),
  credentialRequired: Schema.Literal(false),
});
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Qualification));

/** Capability query never prepares/downloads/records or reads credentials. */
export function probeNativeVoice(executable: string): Promise<boolean> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      executable,
      ["qualify"],
      {
        env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
        timeout: 10_000,
        maxBuffer: 4096,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error) {
          resolve(false);
          return;
        }
        try {
          const result = decode(stdout);
          resolve(
            result.available && ["installed", "supported", "downloading"].includes(result.assets),
          );
        } catch {
          resolve(false);
        }
      },
    );
  });
}
