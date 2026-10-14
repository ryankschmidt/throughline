/**
 * Fork-owned device lifecycle seam: launch declarations and daemon identity
 * are read when consumed, not remembered by the caller. This module is staged
 * and unmounted until advance growth approval and the live P8 contract exist.
 * It must not install tools, choose Xcode, change global settings, or log tokens.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import type { AgentDeviceEndpoint } from "../../device/DeviceHost.ts";
import { agentDeviceStateDir } from "../../device/DeviceToolchain.ts";

class DeviceDeclarationError extends Schema.TaggedError<DeviceDeclarationError>()(
  "ThroughLineDeviceDeclarationError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason;
  }
}

const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export function readMacHostToolchain(value: unknown) {
  const root = object(value);
  if (root?.status === "draft-not-executable")
    throw new DeviceDeclarationError({
      reason: "D10 refuses a draft-not-executable toolchain declaration",
    });
  const mac = object(object(root?.host_toolchain)?.mac);
  if (
    root?.schema !== "throughline.ship-pipeline.v2" ||
    typeof mac?.developer_dir !== "string" ||
    !mac.developer_dir.startsWith("/") ||
    typeof mac.simulator_runtime !== "string" ||
    !/^\d+(?:\.\d+)+$/.test(mac.simulator_runtime)
  )
    throw new DeviceDeclarationError({
      reason: "D10 requires valid host_toolchain.mac.developer_dir and simulator_runtime",
    });
  return { developerDir: mac.developer_dir, simulatorRuntime: mac.simulator_runtime };
}

/** Private capability metadata; errors never include its values. */
export function readDaemonIdentity(value: unknown) {
  const file = object(value);
  if (
    typeof file?.httpPort !== "number" ||
    !Number.isInteger(file.httpPort) ||
    file.httpPort < 1 ||
    file.httpPort > 65535 ||
    typeof file.token !== "string" ||
    file.token.length === 0
  )
    return null;
  return { baseUrl: `http://127.0.0.1:${file.httpPort}`, token: file.token };
}

/** P8's one live file, never the separately named draft or an Xcode fallback. */
export const declaredDaemonEnvironment = Effect.fn("ThroughLineDevice.declaredDaemonEnvironment")(
  function* (
    environment: NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
  ): Effect.fn.Return<
    NodeJS.ProcessEnv,
    DeviceDeclarationError | import("effect/PlatformError").PlatformError,
    FileSystem.FileSystem | Path.Path
  > {
    if (platform !== "darwin") return { ...environment };
    if (!environment.HOME)
      return yield* new DeviceDeclarationError({
        reason: "D10 cannot resolve the live pipeline without HOME",
      });
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(
      environment.HOME,
      "core-root",
      "vault",
      "01_Projects",
      "workbench",
      "infra",
      "throughline",
      "Ship-Pipeline-Tower-Builds.json",
    );
    const raw = yield* fs.readFileString(file);
    const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
      raw,
    ).pipe(
      Effect.mapError(
        () => new DeviceDeclarationError({ reason: "D10 live pipeline is not valid JSON" }),
      ),
    );
    const declaration = yield* Effect.try({
      try: () => readMacHostToolchain(value),
      catch: () =>
        new DeviceDeclarationError({
          reason: "D10 live host_toolchain.mac declaration is absent, draft, or invalid",
        }),
    });
    return { ...environment, DEVELOPER_DIR: declaration.developerDir };
  },
);

/** A fresh file plus health proof at each open; no saved endpoint is an input. */
export const liveDaemonEndpoint = Effect.fn("ThroughLineDevice.liveDaemonEndpoint")(function* (
  stateDir: string,
  entryPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = yield* HttpClient.HttpClient;
  const identity = yield* fs
    .readFileString(path.join(agentDeviceStateDir(path, stateDir), "daemon.json"))
    .pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))),
      Effect.map(readDaemonIdentity),
      Effect.orElseSucceed(() => null),
    );
  if (!identity) return Option.none<AgentDeviceEndpoint>();
  const alive = yield* HttpClient.withScope(client)
    .get(identity.baseUrl + "/health")
    .pipe(
      Effect.flatMap((response) => response.arrayBuffer.pipe(Effect.as(response.status === 200))),
      // The deadline encloses headers AND body, not only request acquisition.
      Effect.timeout(Duration.seconds(2)),
      Effect.scoped,
      Effect.orElseSucceed(() => false),
    );
  return alive
    ? Option.some<AgentDeviceEndpoint>({ ...identity, entryPath })
    : Option.none<AgentDeviceEndpoint>();
});
