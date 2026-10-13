// @effect-diagnostics nodeBuiltinImport:off -- Owns only a spawned scratch CLI and its scoped HTTP client.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpBody, HttpClient } from "effect/http";

const bundle = NodePath.resolve(import.meta.dirname, "../../../../../apps/server/dist/bin.mjs");
const sha = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export interface Server {
  request: (
    endpoint: string,
    body?: unknown,
  ) => Promise<{ readonly status: number; readonly text: () => Promise<string> }>;
  stop: () => Promise<void>;
}

/** Only this helper owns the real Effect runtime used by a process-isolated fixture. */
export async function start(root: string): Promise<Server> {
  const token = NodeCrypto.randomBytes(32).toString("hex");
  const cookie = `t3_dev_session_${sha(Buffer.from(token))}=${token}`;
  const net = await import("node:net");
  const reservation = net.createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address() as import("node:net").AddressInfo;
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const origin = `http://127.0.0.1:${port}`;
  const home = NodePath.join(root, "home");
  NodeFS.mkdirSync(home, { recursive: true });
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      bundle,
      "--mode",
      "web",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--base-dir",
      NodePath.join(root, "state"),
      "--dev-url",
      origin,
      "--no-browser",
      "--log-level",
      "debug",
      root,
    ],
    {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: home, T3CODE_DEV_AUTH_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  const ready = new Promise<void>((resolve, reject) => {
    const output = (data: Buffer) => {
      const text = data
        .toString()
        .split(token)
        .join("[scratch credential redacted]")
        .replace(/(pairingUrl:\s*)\S+/g, "$1[redacted]");
      logs += text;
      if (logs.includes("startup phase: complete")) resolve();
    };
    child.stdout!.on("data", output);
    child.stderr!.on("data", output);
    child.once("error", reject);
    child.once("exit", (code) => {
      reject(new Error(`Scratch server exited ${code}: ${logs.slice(-2000)}`));
    });
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await exited;
    }
    NodeFS.writeFileSync(NodePath.join(root, `server-${child.pid}.log`), logs);
  };
  try {
    // Same real startup marker and 30-second deadline; no polling or timer suppression.
    await Effect.runPromise(Effect.tryPromise(() => ready).pipe(Effect.timeout("30 seconds")));
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    stop,
    request: (endpoint, body) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* HttpClient.HttpClient;
            const options = {
              headers: { cookie, "content-type": "application/json" },
              ...(body === undefined
                ? {}
                : { body: HttpBody.text(encodeJson(body), "application/json") }),
            };
            const response = yield* body === undefined
              ? client.get(origin + endpoint, options)
              : client.post(origin + endpoint, options);
            const text = yield* response.text;
            return { status: response.status, text: () => Promise.resolve(text) };
          }),
        ).pipe(Effect.provide(FetchHttpClient.layer)),
      ),
  };
}

export const reportEvidence = (path: string) =>
  Effect.runPromise(Effect.logInfo(`Attachment preservation evidence: ${path}`));
