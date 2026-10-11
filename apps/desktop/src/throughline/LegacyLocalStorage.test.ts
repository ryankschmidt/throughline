// @effect-diagnostics nodeBuiltinImport:off - Synthetic LevelDB fixture bytes only; no real profile is read.
import { Buffer } from "node:buffer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { getDesktopUrl } from "../electron/ElectronProtocol.ts";
import { make } from "./LegacyLocalStorage.ts";

function logRecord(payload: Uint8Array): Uint8Array {
  const typed = Buffer.concat([Buffer.from([1]), payload]);
  let crc = 0xffffffff;
  for (const byte of typed) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const masked = (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;
  const header = Buffer.alloc(7);
  header.writeUInt32LE(masked);
  header.writeUInt16LE(payload.length, 4);
  header[6] = 1;
  return Buffer.concat([header, payload]);
}

function variable(value: number): Buffer {
  const bytes: number[] = [];
  do {
    const byte = value & 127;
    value = Math.floor(value / 128);
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  return Buffer.from(bytes);
}

function fixtureLog(items: Readonly<Record<string, string>>): Uint8Array {
  const header = Buffer.alloc(12);
  header.writeBigUInt64LE(1n);
  header.writeUInt32LE(Object.keys(items).length, 8);
  const origin = getDesktopUrl(false).replace(/\/$/, "");
  const entries = Object.entries(items).flatMap(([key, value]) => {
    const k = Buffer.concat([
      Buffer.from(`_${origin}\0`, "latin1"),
      Buffer.from([1]),
      Buffer.from(key, "latin1"),
    ]);
    const v = Buffer.concat([Buffer.from([1]), Buffer.from(value, "latin1")]);
    return [Buffer.from([1]), variable(k.length), k, variable(v.length), v];
  });
  return logRecord(Buffer.concat([header, ...entries]));
}

const fixture = (sourceName: string, corrupt = false) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "throughline-legacy-copy-" });
    const directory = path.join(root, sourceName, "Local Storage", "leveldb");
    const destination = path.join(root, "throughline-v2");
    const items = {
      "t3code:prompt-stash:v2":
        '{"version":2,"state":{"entries":[{"id":"fixture","text":"saved prompt"}]}}',
      "t3code:composer-drafts:v1":
        '{"version":1,"state":{"draftsByThreadKey":{"fixture":"unsent draft"}}}',
    };
    const log = fixtureLog(items);
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.makeDirectory(destination);
    yield* fs.writeFileString(
      path.join(directory, "CURRENT"),
      corrupt ? "bad manifest" : "MANIFEST-000001\n",
    );
    yield* fs.writeFile(
      path.join(directory, "MANIFEST-000001"),
      logRecord(Buffer.from([2, 2, 3, 3, 4, 2])),
    );
    yield* fs.writeFile(path.join(directory, "000002.log"), log);
    const environment = DesktopEnvironment.DesktopEnvironment.of({
      appDataDirectory: root,
      isDevelopment: false,
      branding: { baseName: "ThroughLine" },
    } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);
    const create = make.pipe(
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
    );
    return { fs, path, directory, destination, items, log, create };
  });

it.effect.each(["throughline", "T3 Code (Alpha)"])(
  "copies saved drafts from %s once without altering the source",
  (sourceName) =>
    Effect.gen(function* () {
      const f = yield* fixture(sourceName);
      const service = yield* f.create;
      yield* service.load(f.destination);
      assert.deepEqual(Option.getOrNull(yield* service.take), f.items);
      yield* service.complete;
      assert.isTrue(yield* f.fs.exists(f.path.join(f.destination, "v1-local-storage-imported")));
      assert.deepEqual(yield* f.fs.readFile(f.path.join(f.directory, "000002.log")), f.log);
      const second = yield* f.create;
      yield* second.load(f.destination);
      assert.isTrue(Option.isNone(yield* second.take));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects a corrupt copied profile without marking it imported", () =>
  Effect.gen(function* () {
    const f = yield* fixture("throughline", true);
    const service = yield* f.create;
    yield* service.load(f.destination);
    assert.isTrue(Option.isNone(yield* service.take));
    assert.isFalse(yield* f.fs.exists(f.path.join(f.destination, "v1-local-storage-imported")));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
