// @effect-diagnostics nodeBuiltinImport:off - approved Node watch boundary contract tests.
import * as NodeFS from "node:fs";
import * as NodeEvents from "node:events";
import * as NodeModule from "node:module";
import { assert, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as FileSystem from "effect/FileSystem";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import {
  openAcknowledgedWatch,
  NativeWatchFactory,
  PrepareGate,
  type NativeWatchFactoryFn,
} from "./AcknowledgedWatch.ts";

const NodeFs: typeof NodeFS = NodeModule.createRequire(import.meta.url)("node:fs");
const NodeFsNamed = NodeFS;
const { EventEmitter } = NodeEvents;
const { syncBuiltinESMExports } = NodeModule;

class FixtureWatcher extends EventEmitter implements NodeFS.FSWatcher {
  closed = false;
  closeCalls = 0;
  close() {
    this.closeCalls++;
    this.closed = true;
    this.emit("close");
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}
// Compile-negative controls: unused @ts-expect-error is itself a compiler failure.
// Neither rejected function is invoked; these are typing evidence, not runtime tests.
// @ts-expect-error A native factory must not return a Promise.
const rejectsPromiseFactory: NativeWatchFactoryFn = () => Promise.resolve(new FixtureWatcher());
// @ts-expect-error A native factory must not return an Effect.
const rejectsEffectFactory: NativeWatchFactoryFn = () => Effect.succeed(new FixtureWatcher());
void rejectsPromiseFactory;
void rejectsEffectFactory;
type TraceWatcherId = "platform" | "acknowledged" | "unexpected";
interface NativeTraceRow {
  readonly sequence: number;
  readonly phase: string;
  readonly event: string;
  readonly watcher?: TraceWatcherId;
  readonly kind?: string;
  readonly file?: string;
  readonly tag?: FileSystem.WatchEvent["_tag"];
}
interface NativeTraceState {
  phase: string;
  readonly rows: NativeTraceRow[];
  readonly watchers: Array<{
    readonly id: TraceWatcherId;
    readonly watcher: NodeFS.FSWatcher;
    readonly lifecycle: { closeRequested: boolean; closed: boolean };
    readonly onClose: Promise<void>;
  }>;
}
let activeNativeTrace: NativeTraceState | undefined;
const fixtureName = (name: string | null): string =>
  name === "created.json" || name === "before.json" || name === "after.json"
    ? name
    : name === null
      ? "[null]"
      : "[other-fixture-entry]";
const traceNative = (state: NativeTraceState, row: Omit<NativeTraceRow, "sequence" | "phase">) =>
  state.rows.push({ sequence: state.rows.length + 1, phase: state.phase, ...row });
afterEach(async () => {
  const state = activeNativeTrace;
  try {
    if (state) {
      const beforeCleanup = state.watchers.map(({ id, lifecycle }) => ({
        id,
        close_requested: lifecycle.closeRequested,
        close_event_received: lifecycle.closed,
      }));
      state.phase = "fixture-cleanup";
      traceNative(state, { event: "cleanup.begin" });
      for (const owned of state.watchers) {
        if (!owned.lifecycle.closeRequested) {
          traceNative(state, { event: "cleanup.explicit-close", watcher: owned.id });
          owned.watcher.close();
        }
      }
      await Promise.all(state.watchers.map((owned) => owned.onClose));
      traceNative(state, { event: "cleanup.closed" });
      // Fixed fixture names and lifecycle/event metadata only; never content or environment.
      process.stderr.write(
        `WATCH_NATIVE_TRACE ${JSON.stringify({ beforeCleanup, rows: state.rows })}\n`,
      );
    }
  } finally {
    activeNativeTrace = undefined;
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  }
});

// The obsolete Effect-factory red is archived byte-exact in the ownership receipt;
// it cannot be expressed by the new synchronous native-factory signature.

it.effect(
  "acknowledged watcher acquires synchronously before ready and scope closes its handle",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const watcher = new FixtureWatcher();
        const open = vi.spyOn(NodeFs, "watch").mockImplementation(() => watcher);
        syncBuiltinESMExports();
        const scope = yield* Scope.make();
        const subscription = yield* openAcknowledgedWatch("/fixture").pipe(Scope.provide(scope));
        assert.equal(open.mock.calls.length, 1);
        assert.isFalse(watcher.closed);
        yield* subscription.ready;
        assert.equal(open.mock.calls.length, 1, "ready never fabricates a registration");
        yield* Scope.close(scope, Exit.void);
        assert.isTrue(watcher.closed);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("acknowledged watcher registration throw is a typed platform failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      vi.spyOn(NodeFs, "watch").mockImplementation(() => {
        throw Object.assign(new Error("fixture missing"), { code: "ENOENT" });
      });
      syncBuiltinESMExports();
      const result = yield* Effect.exit(openAcknowledgedWatch("/fixture"));
      assert.isTrue(Exit.isFailure(result));
      const error = yield* Effect.flip(openAcknowledgedWatch("/fixture"));
      assert.equal(error._tag, "PlatformError");
      assert.equal(error.reason._tag, "NotFound");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("acknowledged watcher error event fails its stream", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const watcher = new FixtureWatcher();
      vi.spyOn(NodeFs, "watch").mockImplementation(() => watcher);
      syncBuiltinESMExports();
      const subscription = yield* openAcknowledgedWatch("/fixture");
      const reader = yield* subscription.events.pipe(Stream.runHead, Effect.forkScoped);
      watcher.emit(
        "error",
        Object.assign(new Error("controlled watcher failure"), { code: "ENOENT" }),
      );
      const result = yield* Fiber.await(reader);
      assert.isTrue(Exit.isFailure(result));
      const error = yield* Effect.flip(subscription.events.pipe(Stream.runHead));
      assert.equal(
        error.reason._tag,
        "Unknown",
        "platform stream errors preserve Unknown regardless of errno",
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

interface ControlledInput {
  readonly kind: "change" | "rename";
  readonly path: string;
}
interface FiniteMappingPopulation {
  readonly inputs: readonly ControlledInput[];
  readonly outputs: readonly FileSystem.WatchEvent[];
  readonly complete: boolean;
}
const requireFiniteMappingEquality = (
  left: FiniteMappingPopulation,
  right: FiniteMappingPopulation,
): void => {
  if (!left.complete || !right.complete) throw new Error("FiniteMappingIncomplete");
  if (left.inputs.length !== right.inputs.length)
    throw new Error("DifferentInputs: not a mapper verdict");
  for (let index = 0; index < left.inputs.length; index++) {
    if (
      left.inputs[index]!.kind !== right.inputs[index]!.kind ||
      left.inputs[index]!.path !== right.inputs[index]!.path
    ) {
      throw new Error("DifferentInputs: not a mapper verdict");
    }
  }
  // The controlled fixture declares one non-null input -> one output, not an OS drain.
  if (left.outputs.length !== left.inputs.length || right.outputs.length !== right.inputs.length) {
    throw new Error("FiniteMappingPopulationMismatch");
  }
  for (let index = 0; index < left.outputs.length; index++) {
    if (
      left.outputs[index]!._tag !== right.outputs[index]!._tag ||
      left.outputs[index]!.path !== right.outputs[index]!.path
    ) {
      throw new Error(`FiniteMappingOrderMismatch:${index}`);
    }
  }
};
const declaredControlledInputs: readonly ControlledInput[] = [
  { kind: "change", path: "settings.json" },
  { kind: "rename", path: "settings.json" },
  { kind: "rename", path: "settings.json" },
];
const declaredControlledOutputs: readonly FileSystem.WatchEvent[] = [
  { _tag: "Update", path: "settings.json" },
  { _tag: "Create", path: "settings.json" },
  { _tag: "Remove", path: "settings.json" },
];
const finiteFixture = (outputs: readonly FileSystem.WatchEvent[]): FiniteMappingPopulation => ({
  inputs: declaredControlledInputs,
  outputs,
  complete: true,
});

it("CONTROLLED MAPPING INSTRUMENT: identical finite sequences", () => {
  assert.doesNotThrow(() =>
    requireFiniteMappingEquality(
      finiteFixture(declaredControlledOutputs),
      finiteFixture([...declaredControlledOutputs]),
    ),
  );
});
it("CONTROLLED MAPPING INSTRUMENT: rejects reordered outputs", () => {
  assert.throws(
    () =>
      requireFiniteMappingEquality(
        finiteFixture(declaredControlledOutputs),
        finiteFixture([
          declaredControlledOutputs[1]!,
          declaredControlledOutputs[0]!,
          declaredControlledOutputs[2]!,
        ]),
      ),
    "FiniteMappingOrderMismatch:0",
  );
});
it("CONTROLLED MAPPING INSTRUMENT: rejects missing outputs", () => {
  assert.throws(
    () =>
      requireFiniteMappingEquality(
        finiteFixture(declaredControlledOutputs),
        finiteFixture([declaredControlledOutputs[0]!, declaredControlledOutputs[1]!]),
      ),
    "FiniteMappingPopulationMismatch",
  );
});
it("CONTROLLED MAPPING INSTRUMENT: rejects extra outputs", () => {
  assert.throws(
    () =>
      requireFiniteMappingEquality(
        finiteFixture(declaredControlledOutputs),
        finiteFixture([...declaredControlledOutputs, { _tag: "Update", path: "settings.json" }]),
      ),
    "FiniteMappingPopulationMismatch",
  );
});
it("CONTROLLED MAPPING INSTRUMENT: refuses different native inputs", () => {
  assert.throws(
    () =>
      requireFiniteMappingEquality(finiteFixture(declaredControlledOutputs), {
        inputs: [
          { kind: "rename", path: "settings.json" },
          declaredControlledInputs[1]!,
          declaredControlledInputs[2]!,
        ],
        outputs: declaredControlledOutputs,
        complete: true,
      }),
    "DifferentInputs: not a mapper verdict",
  );
});
it("CONTROLLED MAPPING INSTRUMENT: refuses incomplete populations", () => {
  assert.throws(
    () =>
      requireFiniteMappingEquality(finiteFixture(declaredControlledOutputs), {
        inputs: declaredControlledInputs,
        outputs: declaredControlledOutputs,
        complete: false,
      }),
    "FiniteMappingIncomplete",
  );
});

it.effect(
  "CONTROLLED MAPPING, NOT OS DELIVERY: change and rename stat success/failure match the public platform watcher",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        type Side = "platform" | "acknowledged";
        type StatPhase = "success" | "failure";
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-controlled-watch-" });
        const fixtureFile = `${directory}/settings.json`;
        yield* fs.writeFileString(fixtureFile, "controlled fixture");
        const registered = yield* Deferred.make<void>();
        const slots: Array<{
          side: Side;
          watcher: FixtureWatcher;
          listener: NodeFS.WatchListener<string>;
        }> = [];
        vi.spyOn(NodeFs, "watch").mockImplementation(
          (
            _directory,
            options: NodeFS.WatchOptions | NodeFS.WatchListener<string>,
            callback?: NodeFS.WatchListener<string>,
          ) => {
            const listener = typeof options === "function" ? options : callback;
            if (!listener) throw new Error("controlled watcher listener missing");
            const watcher = new FixtureWatcher();
            slots.push({
              side: slots.length === 0 ? "platform" : "acknowledged",
              watcher,
              listener,
            });
            Deferred.doneUnsafe(registered, Effect.void);
            return watcher;
          },
        );
        syncBuiltinESMExports();
        assert.equal(NodeFsNamed.watch, NodeFs.watch);
        const inputs: Record<Side, ControlledInput[]> = { platform: [], acknowledged: [] };
        const outputs: Record<Side, FileSystem.WatchEvent[]> = { platform: [], acknowledged: [] };
        const queues = {
          platform: yield* Queue.make<FileSystem.WatchEvent>(),
          acknowledged: yield* Queue.make<FileSystem.WatchEvent>(),
        };
        const statDone = {
          success: {
            platform: yield* Deferred.make<FileSystem.WatchEvent>(),
            acknowledged: yield* Deferred.make<FileSystem.WatchEvent>(),
          },
          failure: {
            platform: yield* Deferred.make<FileSystem.WatchEvent>(),
            acknowledged: yield* Deferred.make<FileSystem.WatchEvent>(),
          },
        };
        const statReceipts: Array<{ phase: StatPhase; side: Side; result: FileSystem.WatchEvent }> =
          [];
        let statPhase: StatPhase | undefined;
        const observe = (side: Side, event: FileSystem.WatchEvent) =>
          Effect.gen(function* () {
            const completedPhase = statPhase;
            outputs[side].push(event); // Arrival order, before any assertion; no search/buffer/sort.
            yield* Queue.offer(queues[side], event);
            if (
              completedPhase !== undefined &&
              (event._tag === "Create" || event._tag === "Remove")
            ) {
              // Both actual mappers publish these only from the completed stat result branch.
              statReceipts.push({ phase: completedPhase, side, result: event });
              yield* Deferred.succeed(statDone[completedPhase][side], event);
            }
          });
        const platformConsumer = yield* fs.watch(directory).pipe(
          Stream.runForEach((event) => observe("platform", event)),
          Effect.forkScoped,
        );
        yield* Deferred.await(registered);
        const subscription = yield* openAcknowledgedWatch(directory);
        yield* subscription.ready;
        const acknowledgedConsumer = yield* subscription.events.pipe(
          Stream.runForEach((event) => observe("acknowledged", event)),
          Effect.forkScoped,
        );
        assert.lengthOf(
          slots,
          2,
          "actual public platform mapper plus frozen helper, controlled native ports only",
        );
        const feed = (input: ControlledInput) =>
          Effect.sync(() => {
            for (const slot of slots) {
              inputs[slot.side].push(input);
              slot.listener(input.kind, input.path);
            }
          });
        const expectNext = (expected: FileSystem.WatchEvent) =>
          Effect.gen(function* () {
            assert.deepEqual(yield* Queue.take(queues.platform), expected);
            assert.deepEqual(yield* Queue.take(queues.acknowledged), expected);
          });
        yield* feed(declaredControlledInputs[0]!);
        yield* expectNext(declaredControlledOutputs[0]!);
        assert.equal((yield* fs.stat(fixtureFile)).type, "File");
        statPhase = "success";
        yield* feed(declaredControlledInputs[1]!);
        yield* expectNext(declaredControlledOutputs[1]!);
        yield* Deferred.await(statDone.success.platform);
        yield* Deferred.await(statDone.success.acknowledged);
        // No mutation until both stat-dependent mapped result receipts have arrived.
        yield* fs.remove(fixtureFile);
        const absent = yield* Effect.flip(fs.stat(fixtureFile));
        assert.equal(absent.reason._tag, "NotFound");
        statPhase = "failure";
        yield* feed(declaredControlledInputs[2]!);
        yield* expectNext(declaredControlledOutputs[2]!);
        yield* Deferred.await(statDone.failure.platform);
        yield* Deferred.await(statDone.failure.acknowledged);
        // Exactly three declared callbacks per side, all rename results acknowledged.
        // Closing this finite controlled producer ends its queues; not a native drain claim.
        for (const slot of slots) slot.watcher.close();
        yield* Fiber.join(platformConsumer);
        yield* Fiber.join(acknowledgedConsumer);
        assert.deepEqual(inputs.platform, declaredControlledInputs);
        assert.deepEqual(inputs.acknowledged, declaredControlledInputs);
        requireFiniteMappingEquality(
          { inputs: inputs.platform, outputs: outputs.platform, complete: true },
          { inputs: inputs.acknowledged, outputs: outputs.acknowledged, complete: true },
        );
        assert.deepEqual(outputs.platform, declaredControlledOutputs);
        assert.deepEqual(outputs.acknowledged, declaredControlledOutputs);
        assert.lengthOf(statReceipts, 4);
        assert.isTrue(slots.every((slot) => slot.watcher.closed));
        process.stderr.write(
          `WATCH_CONTROLLED_MAPPING ${JSON.stringify({ scope: "CONTROLLED MAPPING, NOT OS DELIVERY", inputs, outputs, statReceipts, declared_inputs_per_side: 3, consumers_ended: true, fixture_watchers_closed: true })}\n`,
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

// prettier-ignore
it.effect(
  "OWNERSHIP: held preparation cannot announce ready before synchronous native registration",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
        const returned = yield* Ref.make(false);
        const factory = yield* NativeWatchFactory;
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-watch-gate-" });
        let registrations = 0;
        const opened = yield* openAcknowledgedWatch(directory).pipe(
          Effect.provideService(PrepareGate, (dir) =>
            dir === directory
              ? Effect.gen(function* () {
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                })
              : Effect.void,
          ),
          Effect.provideService(NativeWatchFactory, (dir, listener) => {
            registrations++;
            return factory(dir, listener);
          }),
          Effect.tap(() => Ref.set(returned, true)),
          Effect.forkScoped,
        );
        yield* Deferred.await(entered);
        assert.equal(registrations, 0);
        assert.isFalse(
          yield* Ref.get(returned),
          "acquire cannot return a ready handle before native registration",
        );
        yield* Deferred.succeed(release, undefined);
        const handle = yield* Fiber.join(opened);
        yield* handle.ready;
        assert.equal(registrations, 1);
        yield* handle.close;
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("OWNERSHIP: scope interrupts a held preparation gate with zero native opens", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const scope = yield* Scope.make();
      let registrations = 0;
      const opening = yield* openAcknowledgedWatch("/fixture").pipe(
        Effect.provideService(PrepareGate, (directory) =>
          directory === "/fixture"
            ? Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              })
            : Effect.void,
        ),
        Effect.provideService(NativeWatchFactory, () => {
          registrations++;
          return new FixtureWatcher();
        }),
        Scope.provide(scope),
        Effect.forkIn(scope),
      );
      yield* Deferred.await(entered);
      yield* Scope.close(scope, Exit.void);
      assert.isTrue(Exit.isFailure(yield* Fiber.await(opening)));
      assert.equal(registrations, 0);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "OWNERSHIP: interruption just after sync open closes the acquired handle exactly once at scope close",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const watcher = new FixtureWatcher();
        const nativeOpened = yield* Deferred.make<void>();
        const afterAcquire = yield* Deferred.make<void>();
        const scope = yield* Scope.make();
        let opens = 0;
        const acquiring = yield* openAcknowledgedWatch("/fixture").pipe(
          Effect.provideService(NativeWatchFactory, () => {
            opens++;
            Deferred.doneUnsafe(nativeOpened, Effect.void);
            return watcher;
          }),
          Effect.andThen(Deferred.await(afterAcquire)),
          Scope.provide(scope),
          Effect.forkIn(scope),
        );
        yield* Deferred.await(nativeOpened);
        yield* Fiber.interrupt(acquiring);
        yield* Scope.close(scope, Exit.void);
        assert.equal(opens, 1);
        assert.equal(
          watcher.closeCalls,
          1,
          "registered acquisition closes before any fixture rescue",
        );
        assert.isTrue(watcher.closed);
        yield* Scope.close(scope, Exit.void);
        assert.equal(watcher.closeCalls, 1, "scope close cannot close the acquired handle twice");
        process.stderr.write(
          `WATCH_OWNERSHIP_SYNC ${JSON.stringify({ opens, closeCalls: watcher.closeCalls, closed: watcher.closed, interruptRequestedAt: "native-open signal, before post-acquire continuation completes", fixtureRescue: false })}\n`,
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
