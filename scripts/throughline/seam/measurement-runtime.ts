import { Console, Crypto, DateTime, Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { NodeCrypto, NodeFileSystem, NodeServices } from "@effect/platform-node";

/** Historical measurement CLI I/O. No application service, provider or policy is owned here. */
const fileSystem = await Effect.runPromise(
  FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer)),
);
const paths = Effect.runSync(Path.Path.pipe(Effect.provide(Path.layer)));
const crypto = Effect.runSync(Crypto.Crypto.pipe(Effect.provide(NodeCrypto.layer)));
export const join = paths.join;
export const posix = paths;
export const readBytes = (path: string) => Effect.runPromise(fileSystem.readFile(path));
export const readText = (path: string) => Effect.runPromise(fileSystem.readFileString(path));
export const write = (path: string, data: string | Uint8Array, options?: { flag?: "wx" | "w" }) =>
  Effect.runPromise(
    typeof data === "string"
      ? fileSystem.writeFileString(path, data, options)
      : fileSystem.writeFile(path, data, options),
  );
export const hash = (data: string | Uint8Array) =>
  Array.from(
    Effect.runSync(
      crypto.digest("SHA-256", typeof data === "string" ? new TextEncoder().encode(data) : data),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
export const now = () => Effect.runSync(DateTime.now.pipe(Effect.map(DateTime.formatIso)));
export const log = (value: string) => Effect.runPromise(Console.log(value));

export function capture(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    input?: string;
    timeout?: number;
    maxBuffer?: number;
  } = {},
) {
  let stdout = "",
    stderr = "",
    stdoutBytes = 0,
    stderrBytes = 0;
  const limit = options.maxBuffer ?? 67108864;
  const operation = Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(command, args, {
          cwd: options.cwd,
          env: options.env,
          stdin:
            options.input === undefined
              ? "ignore"
              : Stream.succeed(new TextEncoder().encode(options.input)),
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const [, , status] = yield* Effect.all(
        [
          Stream.runForEach(child.stdout.pipe(Stream.decodeText()), (chunk) =>
            Effect.sync(() => {
              stdoutBytes += new TextEncoder().encode(chunk).length;
              if (stdoutBytes > limit) throw Error("MEASUREMENT_STDOUT_LIMIT");
              stdout += chunk;
            }),
          ),
          Stream.runForEach(child.stderr.pipe(Stream.decodeText()), (chunk) =>
            Effect.sync(() => {
              stderrBytes += new TextEncoder().encode(chunk).length;
              if (stderrBytes > limit) throw Error("MEASUREMENT_STDERR_LIMIT");
              stderr += chunk;
            }),
          ),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return { stdout, stderr, status: Number(status) };
    }),
  ).pipe(Effect.provide(NodeServices.layer));
  return Effect.runPromise(
    options.timeout === undefined
      ? operation
      : operation.pipe(
          Effect.timeoutOrElse({
            duration: options.timeout,
            orElse: () => Effect.succeed({ stdout, stderr, status: null }),
          }),
        ),
  );
}
