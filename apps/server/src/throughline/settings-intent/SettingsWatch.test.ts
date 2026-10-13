// @effect-diagnostics nodeBuiltinImport:off - finite native ports in namespace lifetime fixtures only.
import type * as NodeFS from "node:fs";
import * as NodeEvents from "node:events";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { NativeWatchFactory, PrepareGate, type PrepareGateFn } from "./AcknowledgedWatch.ts";
import * as SettingsWatch from "./SettingsWatch.ts";

const { EventEmitter } = NodeEvents;

/** Controlled native registration/lifetimes, actual filesystem symlinks; NOT public settings proof. */
class Watcher extends EventEmitter implements NodeFS.FSWatcher {
  closes = 0;
  readonly directory: string;
  readonly mark: (text: string) => void;
  constructor(directory: string, mark: (text: string) => void) {
    super();
    this.directory = directory;
    this.mark = mark;
  }
  close() {
    this.closes++;
    this.mark(`close:${this.directory}`);
    this.emit("close");
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}

const fixture = Effect.gen(function* () {
  const base = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* base.makeTempDirectoryScoped({ prefix: "t3-settings-coordinator-" });
  const link = path.join(root, "link", "settings.json");
  const targets = Object.fromEntries(
    ["a", "b", "c"].map((name) => [name, path.join(root, name, "settings.json")]),
  );
  for (const file of [link, ...Object.values(targets)]) {
    yield* base.makeDirectory(path.dirname(file), { recursive: true });
  }
  yield* base.symlink(targets.a!, link);
  const directory = yield* Queue.make<FileSystem.WatchEvent>();
  yield* Effect.addFinalizer(() => Queue.shutdown(directory));
  const fs: FileSystem.FileSystem = { ...base, watch: () => Stream.fromQueue(directory) };
  const owner = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void));
  const watchers = new Map<string, Watcher>();
  const listeners = new Map<string, NodeFS.WatchListener<string>>();
  const markers: string[] = [];
  const observations: SettingsWatch.WatchObservation[] = [];
  const observationGates = new Map<string, Deferred.Deferred<void>>();
  const publications = yield* Queue.make<string>();
  const refusedDirectories = new Map<string, Error>();
  const mark = (text: string) => markers.push(text);
  const native = (directory: string, listener: NodeFS.WatchListener<string>) => {
    mark(`open-request:${directory}`);
    const error = refusedDirectories.get(directory);
    if (error) throw error;
    const watcher = new Watcher(directory, mark);
    watchers.set(directory, watcher);
    listeners.set(directory, listener);
    mark(`open-return:${directory}`);
    return watcher;
  };
  const observe = (event: SettingsWatch.WatchObservation) => {
    observations.push(event);
    mark(`${event.kind}:${event.path}`);
    const gate = observationGates.get(`${event.kind}:${event.path}`);
    if (gate) Deferred.doneUnsafe(gate, Effect.void);
  };
  const revalidate = Effect.gen(function* () {
    const committed = yield* SettingsWatch.CommittedSettingsWatchPath;
    assert.isDefined(committed);
    mark(`publish:${committed}`);
    yield* Queue.offer(publications, committed!);
  });
  const start = (gate: PrepareGateFn = () => Effect.void) =>
    SettingsWatch.make(link, fs, path, owner, revalidate).pipe(
      Effect.provideService(NativeWatchFactory, native),
      Effect.provideService(PrepareGate, gate),
      Effect.provideService(SettingsWatch.ObserveSettingsWatch, observe),
    );
  const arm = (kind: SettingsWatch.WatchObservation["kind"], file: string) =>
    Deferred.make<void>().pipe(
      Effect.tap((gate) => Effect.sync(() => observationGates.set(`${kind}:${file}`, gate))),
    );
  const repoint = (file: string) =>
    base.remove(link).pipe(Effect.andThen(base.symlink(file, link)));
  const notify = Queue.offer(directory, { _tag: "Update", path: "settings.json" });
  const targetEvent = (file: string) =>
    Effect.sync(() => {
      const listener = listeners.get(path.dirname(file));
      assert.isDefined(listener, "target reader must have an actual acquired fixture port");
      listener!("change", "settings.json");
    });
  return {
    base,
    path,
    link,
    targets,
    owner,
    watchers,
    markers,
    observations,
    refusedDirectories,
    publications,
    start,
    arm,
    repoint,
    notify,
    targetEvent,
  };
});

const run = <A, E>(body: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>) =>
  Effect.scoped(body).pipe(TestClock.withLive, Effect.provide(NodeServices.layer));

it.effect("COORDINATOR: initial target preparation gates ready before any native open", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let returned = false;
      const start = yield* f.start((dir) =>
        dir === f.path.dirname(f.targets.a!)
          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Effect.void,
      );
      const fiber = yield* start.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            returned = true;
          }),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(entered);
      assert.isFalse(returned);
      assert.equal(f.watchers.size, 0);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(fiber);
      assert.isTrue(returned);
      assert.equal(f.watchers.size, 1);
      assert.equal(
        f.observations.filter((e) => e.kind === "reader-entered" && e.path === f.targets.a).length,
        1,
      );
      yield* start;
      assert.equal(f.watchers.size, 1, "second start shares actual initial readiness");
      yield* Scope.close(f.owner, Exit.void);
      assert.equal(f.watchers.get(f.path.dirname(f.targets.a!))!.closes, 1);
    }),
  ),
);

it.effect("COORDINATOR: cancel held initial preparation with zero native registrations", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const start = yield* f.start(() =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      );
      const fiber = yield* start.pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      yield* Scope.close(f.owner, Exit.void);
      assert.equal(f.watchers.size, 0);
    }),
  ),
);

it.effect("COORDINATOR: replacement ready and reader entry precede old close and publication", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const a = f.targets.a!,
        b = f.targets.b!;
      const start = yield* f.start((dir) =>
        dir === f.path.dirname(b)
          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Effect.void,
      );
      yield* start;
      yield* f.repoint(b);
      yield* f.notify;
      yield* Deferred.await(entered);
      assert.equal(f.watchers.get(f.path.dirname(a))!.closes, 0);
      assert.isFalse(f.watchers.has(f.path.dirname(b)));
      assert.equal(f.markers.filter((m) => m.startsWith("publish:")).length, 0);
      const oldReceived = yield* f.arm("signal-queued", a);
      yield* f.targetEvent(a);
      yield* Deferred.await(oldReceived);
      assert.equal(
        f.watchers.get(f.path.dirname(a))!.closes,
        0,
        "old reader still drains while new prepare is held",
      );
      assert.equal(f.markers.filter((m) => m.startsWith("publish:")).length, 0);
      yield* Deferred.succeed(release, undefined);
      assert.equal(yield* Queue.take(f.publications), b);
      const index = (name: string) => {
        const i = f.markers.indexOf(name);
        assert.isAtLeast(i, 0);
        return i;
      };
      assert.isBelow(index(`open-return:${f.path.dirname(b)}`), index(`reader-entered:${b}`));
      assert.isBelow(index(`reader-entered:${b}`), index(`close:${f.path.dirname(a)}`));
      assert.isBelow(index(`close:${f.path.dirname(a)}`), index(`committed:${b}`));
      assert.isBelow(index(`committed:${b}`), index(`publish:${b}`));
      yield* Scope.close(f.owner, Exit.void);
      assert.equal(f.watchers.get(f.path.dirname(a))!.closes, 1);
      assert.equal(f.watchers.get(f.path.dirname(b))!.closes, 1);
    }),
  ),
);

it.effect("COORDINATOR: refused replacement keeps old reader and withholds callback", () =>
  run(
    Effect.gen(function* () {
      const f = yield* fixture;
      const a = f.targets.a!,
        b = f.targets.b!;
      const start = yield* f.start();
      yield* start;
      const refused = yield* f.arm("replacement-refused", b);
      f.refusedDirectories.set(
        f.path.dirname(b),
        Object.assign(new Error("fixture registration refused"), { code: "EACCES" }),
      );
      yield* f.repoint(b);
      yield* f.notify;
      yield* Deferred.await(refused);
      assert.equal(f.watchers.get(f.path.dirname(a))!.closes, 0);
      assert.isFalse(f.watchers.has(f.path.dirname(b)));
      assert.equal(f.markers.filter((m) => m.startsWith("publish:")).length, 0);
      const received = yield* f.arm("signal-queued", a);
      yield* f.targetEvent(a);
      yield* Deferred.await(received);
      assert.equal(f.watchers.get(f.path.dirname(a))!.closes, 0);
      yield* f.repoint(a);
      yield* f.notify;
      assert.equal(yield* Queue.take(f.publications), a);
      yield* Scope.close(f.owner, Exit.void);
      assert.equal(f.watchers.get(f.path.dirname(a))!.closes, 1);
    }),
  ),
);

it.effect(
  "COORDINATOR: initial registration failure is public typed error with original cause",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        const raw = Object.assign(new Error("fixture registration refused"), { code: "ENOENT" });
        f.refusedDirectories.set(f.path.dirname(f.targets.a!), raw);
        const start = yield* f.start();
        const error = yield* Effect.flip(start);
        assert.equal(error._tag, "ServerSettingsError");
        assert.equal(
          error.operation,
          "prepare-directory",
          "qualified public operation approximation, not enum expansion",
        );
        assert.match(error.message, /link-target watch registration/);
        const platform = error.cause;
        assert.isTrue(
          typeof platform === "object" &&
            platform !== null &&
            "_tag" in platform &&
            platform._tag === "PlatformError",
        );
        if (typeof platform === "object" && platform !== null && "cause" in platform)
          assert.equal(platform.cause, raw);
        else assert.fail("original typed platform cause unavailable");
        assert.equal(f.watchers.size, 0);
        const again = yield* Effect.flip(start);
        assert.equal(again, error, "failed initial readiness is shared, not a retry");
      }),
    ),
);

it.effect(
  "COORDINATOR: rapid observed repoints stay sequential with logical committed references",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        const a = f.targets.a!,
          b = f.targets.b!,
          c = f.targets.c!;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const start = yield* f.start((dir) =>
          dir === f.path.dirname(b)
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
        );
        yield* start;
        yield* f.repoint(b);
        yield* f.notify;
        yield* Deferred.await(entered);
        yield* f.repoint(c);
        yield* f.notify;
        assert.isFalse(f.watchers.has(f.path.dirname(c)));
        yield* Deferred.succeed(release, undefined);
        assert.equal(
          yield* Queue.take(f.publications),
          b,
          "logical reference only: opaque callback filesystem read is not pinned",
        );
        assert.equal(yield* Queue.take(f.publications), c);
        assert.isBelow(
          f.markers.indexOf(`committed:${b}`),
          f.markers.indexOf(`open-return:${f.path.dirname(c)}`),
        );
        yield* Scope.close(f.owner, Exit.void);
        for (const file of [a, b, c]) assert.equal(f.watchers.get(f.path.dirname(file))!.closes, 1);
      }),
    ),
);

it.effect(
  "COORDINATOR: direct-file transition closes link watcher and preserves directory reader",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        const start = yield* f.start();
        yield* start;
        yield* f.base.remove(f.link);
        yield* f.base.writeFileString(f.link, "fixture");
        yield* f.notify;
        assert.equal(yield* Queue.take(f.publications), f.path.resolve(f.link));
        assert.equal(f.watchers.get(f.path.dirname(f.targets.a!))!.closes, 1);
        yield* f.notify;
        assert.equal(yield* Queue.take(f.publications), f.path.resolve(f.link));
        yield* Scope.close(f.owner, Exit.void);
        assert.equal(f.watchers.get(f.path.dirname(f.targets.a!))!.closes, 1);
      }),
    ),
);

it.effect(
  "COORDINATOR: target stream error is observed and scope closes its registered handle",
  () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture;
        const start = yield* f.start();
        yield* start;
        const failed = yield* f.arm("reader-error", f.targets.a!);
        f.watchers
          .get(f.path.dirname(f.targets.a!))!
          .emit("error", new Error("fixture watcher error"));
        yield* Deferred.await(failed);
        yield* Scope.close(f.owner, Exit.void);
        assert.equal(f.watchers.get(f.path.dirname(f.targets.a!))!.closes, 1);
      }),
    ),
);
