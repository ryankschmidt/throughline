import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as LocalDeviceHost from "../../device/LocalDeviceHost.ts";
import * as ServerConfig from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { AGENT_DEVICE_VERSION, DEVICE_HUB_VERSION } from "../../device/DeviceToolchain.ts";

// Real host service and filesystem; only external processes and HTTP are fixtures.
// Tokens below are public synthetic fixture strings, never live daemon metadata.
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const base = yield* fs.makeTempDirectoryScoped({ prefix: "d10-mount-test-" });
  const config = yield* Effect.gen(function* () {
    return yield* ServerConfig.ServerConfig;
  }).pipe(Effect.provide(ServerConfig.layerTest(base, base)));
  const state = config.stateDir;
  const daemon = `${state}/device/agent-device/daemon.json`;
  const declaration = `${base}/core-root/vault/01_Projects/workbench/infra/throughline/Ship-Pipeline-Tower-Builds.json`;
  const hubInstall = `${base}/tools/expo-device-hub/${DEVICE_HUB_VERSION}`;
  const agentInstall = `${base}/tools/agent-device/${AGENT_DEVICE_VERSION}`;
  for (const [directory, entry, version] of [
    [hubInstall, "node_modules/expo-device-hub/dist/server/cli.mjs", DEVICE_HUB_VERSION],
    [agentInstall, "node_modules/agent-device/bin/agent-device.mjs", AGENT_DEVICE_VERSION],
  ]) {
    const file = `${directory}/${entry}`;
    yield* fs.makeDirectory(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    yield* fs.writeFileString(file, "fixture");
    yield* fs.writeFileString(`${directory}/.install-complete`, version!);
  }
  yield* fs.makeDirectory(`${state}/device/agent-device`, { recursive: true });
  yield* fs.makeDirectory(declaration.slice(0, declaration.lastIndexOf("/")), { recursive: true });
  let developerDir = "/fixture/Xcode-A.app/Contents/Developer";
  const declare = () =>
    fs.writeFileString(
      declaration,
      JSON.stringify({
        schema: "throughline.ship-pipeline.v2",
        host_toolchain: { mac: { developer_dir: developerDir, simulator_runtime: "26.5" } },
      }),
    );
  const identity = (port: number) =>
    fs.writeFileString(
      daemon,
      JSON.stringify({
        httpPort: port,
        token: "public-d10-fixture-token",
      }),
    );
  const launches: NodeJS.ProcessEnv[] = [];
  const healthUrls: string[] = [];
  const hubExited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
  const environment = { HOME: base, PATH: "/fixture/bin", DEVELOPER_DIR: "/wrong/global" };
  const host = yield* LocalDeviceHost.make().pipe(
    Effect.provideService(ServerConfig.ServerConfig, config),
    Effect.provide(NetService.layer),
    Effect.provideService(HostProcess.Environment, environment),
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(HostProcess.IsExecutable, false),
    Effect.provideService(HostProcess.ExecutablePath, "/fixture/node"),
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(123456789),
            exitCode: Deferred.await(hubExited),
            isRunning: Effect.succeed(true),
            kill: () => Deferred.succeed(hubExited, ChildProcessSpawner.ExitCode(0)),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          }),
        ),
      ),
    ),
    Effect.provideService(ProcessRunner.ProcessRunner, {
      run: (command) =>
        Effect.gen(function* () {
          if (command.args?.includes("devices")) {
            launches.push({ ...command.env });
            yield* identity(41100 + launches.length);
          }
          return {
            stdout: "",
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          } satisfies ProcessRunner.ProcessRunOutput;
        }).pipe(Effect.orDie),
    }),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        if (request.url.endsWith("/health")) healthUrls.push(request.url);
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("{}", { status: 200 })),
        );
      }),
    ),
  );
  yield* Effect.addFinalizer(() => host.stop);
  return {
    host,
    fs,
    daemon,
    declaration,
    declare,
    identity,
    launches,
    healthUrls,
    environment,
    setDeveloperDir: (value: string) => {
      developerDir = value;
    },
  };
});

it.effect(
  "rereads daemon identity when a ready host is reopened after a daemon-only relaunch",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.declare();
      yield* f.identity(40101);
      const first = yield* f.host.ensureAgentReady(() => Effect.void);
      expect(first.agentDevice.baseUrl).toBe("http://127.0.0.1:40101");
      yield* f.identity(40102);
      const reopened = yield* f.host.ensureAgentReady(() => Effect.void);
      expect(reopened.agentDevice.baseUrl).toBe("http://127.0.0.1:40102");
      expect(f.healthUrls).toContain("http://127.0.0.1:40102/health");
      expect(f.launches).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "each daemon launch uses the current declaration without changing the global environment",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.declare();
      const first = yield* f.host.ensureAgentReady(() => Effect.void);
      expect(first.agentDevice.baseUrl).toBe("http://127.0.0.1:41101");
      expect(f.launches[0]?.DEVELOPER_DIR).toBe("/fixture/Xcode-A.app/Contents/Developer");
      f.setDeveloperDir("/fixture/Xcode-B.app/Contents/Developer");
      yield* f.declare();
      yield* f.fs.remove(f.daemon);
      const second = yield* f.host.ensureAgentReady(() => Effect.void);
      expect(second.agentDevice.baseUrl).toBe("http://127.0.0.1:41102");
      expect(f.launches[1]?.DEVELOPER_DIR).toBe("/fixture/Xcode-B.app/Contents/Developer");
      expect(f.environment.DEVELOPER_DIR).toBe("/wrong/global");
      expect(f.launches).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
