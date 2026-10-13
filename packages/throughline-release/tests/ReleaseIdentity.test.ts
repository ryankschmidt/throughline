import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const stamp = {
  schema: "throughline.release-stamp.v1",
  version: "0.0.56",
  commit: "d18fc5d631ff64b5a121e614e409ea8356d0ab3b",
  cut_from: "main",
  stamped_at: "2026-10-13T11:00:00.000Z",
  stamped_by: "throughline-ship@0.4.26",
  platforms: ["mac", "tower-desktop", "tower-headless", "iphone", "android"],
  deferred: [
    {
      platform: "rpi",
      ruling:
        "Raspberry Pi paused, from Ryan: install nothing on the Raspberry Pi in this release.",
      source:
        "/Users/Admin/core-root/vault/01_Projects/workbench/infra/throughline/Ship-Pipeline-Tower-Builds.json#deferred.rpi.ruling",
    },
  ],
};

const fixture = (kind: "valid" | "missing" | "malformed" | "development") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve(new URL("../../../", import.meta.url).pathname);
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "throughline-release-identity-" });
    const copy = (file: string) =>
      Effect.gen(function* () {
        if (!(yield* fs.exists(path.join(root, file)))) return;
        yield* fs.makeDirectory(path.dirname(path.join(dir, file)), { recursive: true });
        yield* fs.writeFileString(
          path.join(dir, file),
          yield* fs.readFileString(path.join(root, file)),
        );
      });
    for (const file of [
      "apps/mobile/app.config.ts",
      "apps/web/vite.config.ts",
      "apps/web/vite/tailwind.ts",
      "scripts/lib/public-config.ts",
      "scripts/lib/brand-assets.ts",
      "scripts/lib/third-party-licenses.ts",
      "packages/throughline-release/src/index.ts",
      "scripts/throughline/release-identity/WebReleaseBuild.ts",
    ])
      yield* copy(file);
    yield* fs.writeFileString(path.join(dir, "package.json"), '{"type":"module"}');
    for (const surface of ["apps/web", "packages/contracts"]) {
      yield* fs.makeDirectory(path.join(dir, surface), { recursive: true });
      yield* fs.writeFileString(
        path.join(dir, surface, "package.json"),
        '{"type":"module","version":"0.0.45"}',
      );
    }
    yield* fs.makeDirectory(path.join(dir, "packages/throughline-release"), { recursive: true });
    if (kind !== "missing")
      yield* fs.writeFileString(
        path.join(dir, "packages/throughline-release/ThroughLine-Release-Stamp.json"),
        kind === "development"
          ? JSON.stringify({ ...stamp, stamped_by: "development:worker-upmerge-6716f643" })
          : kind === "valid"
            ? JSON.stringify(stamp)
            : '{"schema":"throughline.release-stamp.v1","version":"0.0.0"}',
      );
    yield* fs.symlink(path.join(root, "node_modules"), path.join(dir, "node_modules"));
    for (const surface of ["apps/web", "scripts"]) {
      yield* fs.makeDirectory(path.join(dir, surface), { recursive: true });
      yield* fs.symlink(
        path.join(root, surface, "node_modules"),
        path.join(dir, surface, "node_modules"),
      );
    }
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const evaluate = (code: string) =>
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(process.execPath, ["--input-type=module", "-e", code], {
            cwd: dir,
            env: {
              PATH: "/usr/bin:/bin",
              HOME: dir,
              NODE_NO_WARNINGS: "1",
              APP_VARIANT: "production",
            },
            extendEnv: false,
          }),
        );
        const [out, err, exit] = yield* Effect.all(
          [Stream.runCollect(child.stdout), Stream.runCollect(child.stderr), child.exitCode],
          { concurrency: "unbounded" },
        );
        const decode = (chunks: readonly Uint8Array[]) =>
          chunks.map((chunk) => new TextDecoder().decode(chunk)).join("");
        return { stdout: decode(out), stderr: decode(err), code: Number(exit) };
      });
    const mobile = yield* evaluate(
      `const {default:c}=await import(${JSON.stringify("file://" + path.join(dir, "apps/mobile/app.config.ts"))}); process.stdout.write(JSON.stringify({version:c.version,extra:c.extra.throughlineVersion,ios:c.ios.buildNumber,android:c.android.versionCode}));`,
    );
    const web = yield* evaluate(
      `import fs from 'node:fs';import {loadConfigFromFile} from 'vite-plus'; const run=async()=>{const r=await loadConfigFromFile({command:'build',mode:'production'},${JSON.stringify(path.join(dir, "apps/web/vite.config.ts"))});process.stdout.write(JSON.stringify({version:JSON.parse(r.config.define['import.meta.env.APP_VERSION'])}));}; const wrapper=${JSON.stringify(path.join(dir, "scripts/throughline/release-identity/WebReleaseBuild.ts"))};if(fs.existsSync(wrapper)){const w=await import('file://'+wrapper);await w.withWebReleaseStamp((p)=>fs.readFileSync(p,'utf8'),run);}else await run();`,
    );
    return { mobile, web };
  });

it.effect("release stamp controls actual web definition and Expo version/extra/build numbers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { mobile, web } = yield* fixture("valid");
      assert.equal(mobile.code, 0, mobile.stderr);
      assert.equal(web.code, 0, web.stderr);
      assert.deepEqual(JSON.parse(mobile.stdout), {
        version: stamp.version,
        extra: stamp.version,
        ios: "56",
        android: 56,
      });
      assert.deepEqual(JSON.parse(web.stdout), { version: stamp.version });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["missing", "malformed"] as const)(
  "release stamp %s refuses both real config/build consumers",
  (kind) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { mobile, web } = yield* fixture(kind);
        assert.notEqual(mobile.code, 0, "Expo must refuse, not silently use stock version");
        assert.notEqual(web.code, 0, "Web build must refuse, not silently use stock version");
        assert.include(mobile.stderr, "RELEASE_STAMP");
        assert.include(web.stderr, "RELEASE_STAMP");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("development stamp refuses both actual production config/build consumers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { mobile, web } = yield* fixture("development");
      assert.notEqual(mobile.code, 0, "Expo must not build a release from development identity");
      assert.notEqual(web.code, 0, "Web must not build a release from development identity");
      assert.include(mobile.stderr, "RELEASE_STAMP_DEVELOPMENT_NOT_RELEASE");
      assert.include(web.stderr, "RELEASE_STAMP_DEVELOPMENT_NOT_RELEASE");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
