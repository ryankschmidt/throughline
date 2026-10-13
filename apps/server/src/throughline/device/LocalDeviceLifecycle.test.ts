import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Option from "effect/Option";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import type { AgentDeviceEndpoint } from "../../device/DeviceHost.ts";
import {
  readMacHostToolchain,
  readDaemonIdentity,
  declaredDaemonEnvironment,
  liveDaemonEndpoint,
} from "./LocalDeviceLifecycle.ts";

describe("declared device host toolchain", () => {
  it("reads the P8 Mac fields without confusing runtime and Xcode versions", () => {
    expect(
      readMacHostToolchain({
        schema: "throughline.ship-pipeline.v2",
        host_toolchain: {
          mac: { developer_dir: "/test/Xcode.app/Contents/Developer", simulator_runtime: "26.5" },
        },
      }),
    ).toEqual({ developerDir: "/test/Xcode.app/Contents/Developer", simulatorRuntime: "26.5" });
  });
  it("refuses absent declarations instead of inheriting a global Xcode", () => {
    expect(() => readMacHostToolchain({ schema: "throughline.ship-pipeline.v1" })).toThrow(
      "host_toolchain.mac",
    );
  });
  it.each(["relative/Xcode", "", 12])(
    "refuses an invalid developer directory: %s",
    (developer_dir) => {
      expect(() =>
        readMacHostToolchain({
          schema: "throughline.ship-pipeline.v2",
          host_toolchain: { mac: { developer_dir, simulator_runtime: "26.5" } },
        }),
      ).toThrow();
    },
  );
  it("requires the declared simulator runtime", () => {
    expect(() =>
      readMacHostToolchain({
        schema: "throughline.ship-pipeline.v2",
        host_toolchain: { mac: { developer_dir: "/test/Xcode" } },
      }),
    ).toThrow();
  });
  it("does not activate an explicitly non-executable draft", () => {
    expect(() =>
      readMacHostToolchain({
        schema: "throughline.ship-pipeline.v2",
        status: "draft-not-executable",
        host_toolchain: { mac: { developer_dir: "/test/Xcode", simulator_runtime: "26.5" } },
      }),
    ).toThrow("draft-not-executable");
  });
});

it.effect(
  "rereads the declaration at each consumption without changing the supplied environment",
  () =>
    Effect.gen(function* () {
      let developerDir = "/test/Xcode-A";
      const environment = {
        HOME: "/test/home",
        PATH: "/owned/bin",
        DEVELOPER_DIR: "/wrong/global",
      };
      const run = declaredDaemonEnvironment(environment, "darwin").pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            readFileString: (file) => {
              expect(file).toBe(
                "/test/home/core-root/vault/01_Projects/workbench/infra/throughline/Ship-Pipeline-Tower-Builds.json",
              );
              return Effect.sync(() =>
                JSON.stringify({
                  schema: "throughline.ship-pipeline.v2",
                  host_toolchain: {
                    mac: { developer_dir: developerDir, simulator_runtime: "26.5" },
                  },
                }),
              );
            },
          }),
        ),
        Effect.provide(NodePath.layerPosix),
      );
      expect((yield* run).DEVELOPER_DIR).toBe("/test/Xcode-A");
      developerDir = "/test/Xcode-B";
      expect((yield* run).DEVELOPER_DIR).toBe("/test/Xcode-B");
      expect(environment.DEVELOPER_DIR).toBe("/wrong/global");
      expect((yield* run).PATH).toBe("/owned/bin");
    }),
);

it.effect("consumes a fresh healthy daemon endpoint and refuses an unhealthy replacement", () =>
  Effect.gen(function* () {
    let port = 41001,
      healthy = true;
    const requested: string[] = [];
    const run = liveDaemonEndpoint("/test/userdata", "/owned/agent-device.mjs").pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readFileString: (file) => {
            expect(file).toBe("/test/userdata/device/agent-device/daemon.json");
            return Effect.sync(() =>
              JSON.stringify({ httpPort: port, token: "public-fixture-not-a-credential" }),
            );
          },
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            requested.push(request.url);
            return HttpClientResponse.fromWeb(
              request,
              new Response("ok", { status: healthy ? 200 : 503 }),
            );
          }),
        ),
      ),
      Effect.provide(NodePath.layerPosix),
    );
    const first = yield* run;
    expect(Option.isSome(first) && first.value.baseUrl).toBe("http://127.0.0.1:41001");
    port = 41002;
    const second = yield* run;
    expect(Option.isSome(second) && second.value.baseUrl).toBe("http://127.0.0.1:41002");
    healthy = false;
    expect(Option.isNone(yield* run)).toBe(true);
    expect(requested).toEqual([
      "http://127.0.0.1:41001/health",
      "http://127.0.0.1:41002/health",
      "http://127.0.0.1:41002/health",
    ]);
  }),
);

describe("live daemon identity", () => {
  it("reflects a new daemon identity on the next read", () => {
    const first = readDaemonIdentity({ httpPort: 41001, token: "public-fixture-A" });
    const second = readDaemonIdentity({ httpPort: 41002, token: "public-fixture-B" });
    expect(first?.baseUrl).toBe("http://127.0.0.1:41001");
    expect(second?.baseUrl).toBe("http://127.0.0.1:41002");
    expect(second?.token).toBe("public-fixture-B");
  });
  it.each([0, 65536, 1.5, "41001"])("rejects invalid ports: %s", (httpPort) => {
    expect(readDaemonIdentity({ httpPort, token: "public-fixture" })).toBeNull();
  });
  it.each([null, {}, { httpPort: 41001 }, { httpPort: 41001, token: "" }])(
    "rejects missing identity without exposing it in errors",
    (value) => {
      expect(readDaemonIdentity(value)).toBeNull();
    },
  );
});

it.effect("bounds a health body that never completes after successful headers", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const finished = yield* Deferred.make<Option.Option<AgentDeviceEndpoint>>();
    let interrupted = false;
    const run = liveDaemonEndpoint("/test/userdata", "/owned/agent-device.mjs").pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readFileString: () => Effect.succeed('{"httpPort":41001,"token":"public-fixture"}'),
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          const response: HttpClientResponse.HttpClientResponse = Object.create(
            HttpClientResponse.fromWeb(request, new Response("ok", { status: 200 })),
          );
          Object.defineProperty(response, "arrayBuffer", {
            value: Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  interrupted = true;
                }),
              ),
            ),
          });
          return Effect.succeed(response);
        }),
      ),
      Effect.provide(NodePath.layerPosix),
      Effect.flatMap((result) => Deferred.succeed(finished, result)),
    );
    yield* Effect.forkChild(run);
    yield* Deferred.await(started);
    yield* TestClock.adjust("1 second");
    expect(Option.isNone(yield* Deferred.poll(finished))).toBe(true);
    yield* TestClock.adjust("1 second");
    const completion = yield* Deferred.poll(finished);
    expect(Option.isSome(completion)).toBe(true);
    if (Option.isSome(completion)) expect(Option.isNone(yield* completion.value)).toBe(true);
    expect(interrupted).toBe(true);
  }),
);
