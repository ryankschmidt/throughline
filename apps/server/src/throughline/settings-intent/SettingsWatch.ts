import { ServerSettingsError } from "@t3tools/contracts";
import { resolveSymlinkTarget } from "@t3tools/shared/symlink";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { NativeWatchFactory, PrepareGate, openAcknowledgedWatch } from "./AcknowledgedWatch.ts";

/** Logical committed reference only; the existing callback still reads the physical settings path. */
export const CommittedSettingsWatchPath = Context.Reference<string | undefined>(
  "t3/throughline/settings-intent/CommittedSettingsWatchPath",
  { defaultValue: () => undefined },
);
export interface WatchObservation {
  readonly kind:
    | "reader-entered"
    | "signal-queued"
    | "reader-error"
    | "committed"
    | "replacement-refused";
  readonly path: string;
  readonly generation: number;
}
/** Read-only fixture witness; no environment, persisted configuration, or production supplier. */
export const ObserveSettingsWatch = Context.Reference<
  ((event: WatchObservation) => void) | undefined
>("t3/throughline/settings-intent/ObserveSettingsWatch", { defaultValue: () => undefined });

class LinkTargetRegistrationError extends ServerSettingsError {
  override get message(): string {
    return `Server settings link-target watch registration failed at ${this.settingsPath}.`;
  }
}
interface TargetLifetime {
  readonly path: string;
  readonly generation: number;
  readonly scope: Scope.Closeable;
}
interface WatchSignal {
  readonly source: "directory" | "target";
  readonly generation: number;
}

/** Secret: target lifetime handoff and watcher-triggered publication order; never settings content. */
export const make = (
  settingsPath: string,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  owner: Scope.Scope,
  revalidate: Effect.Effect<void, ServerSettingsError>,
) =>
  Effect.gen(function* () {
    // Capture construction context, because the service's later start call need not carry fixture tags.
    const nativeFactory = yield* NativeWatchFactory;
    const prepareGate = yield* PrepareGate;
    const observer = yield* ObserveSettingsWatch;
    const scope = yield* Scope.fork(owner, "sequential");
    const signals = yield* Queue.make<WatchSignal, Cause.Done>();
    yield* Scope.addFinalizer(scope, Queue.shutdown(signals));
    const active = yield* Ref.make<TargetLifetime | undefined>(undefined);
    const started = yield* Ref.make(false);
    const ready = yield* Deferred.make<void, ServerSettingsError>();
    let nextGeneration = 0;
    const observe = (kind: WatchObservation["kind"], target: string, generation: number) =>
      observer === undefined
        ? Effect.void
        : Effect.sync(() => observer({ kind, path: target, generation }));
    const matches = (file: string, event: FileSystem.WatchEvent) =>
      event.path === path.basename(file) ||
      event.path === file ||
      path.resolve(path.dirname(file), event.path) === path.resolve(file);
    const resolveTarget = resolveSymlinkTarget(settingsPath).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.map((target) => (target === path.resolve(settingsPath) ? undefined : target)),
    );
    const reader = (
      events: Stream.Stream<FileSystem.WatchEvent, import("effect/PlatformError").PlatformError>,
      file: string,
      generation: number,
      lifetime: Scope.Scope,
      source: WatchSignal["source"],
    ) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        yield* events.pipe(
          Stream.filter((event) => matches(file, event)),
          Stream.onStart(
            observe("reader-entered", file, generation).pipe(
              Effect.andThen(Deferred.succeed(entered, undefined)),
            ),
          ),
          Stream.runForEach(() =>
            Queue.offer(signals, { source, generation }).pipe(
              Effect.andThen(observe("signal-queued", file, generation)),
            ),
          ),
          Effect.catchCause((cause) =>
            observe("reader-error", file, generation).pipe(
              Effect.andThen(Effect.logError("Settings watcher reader failed", cause)),
            ),
          ),
          Effect.forkIn(lifetime),
        );
        yield* Deferred.await(entered);
      });
    const activate = (target: string | undefined) =>
      Effect.gen(function* () {
        const previous = yield* Ref.get(active);
        if (previous?.path === target || (previous === undefined && target === undefined)) return;
        let replacement: TargetLifetime | undefined;
        if (target !== undefined) {
          const pending = yield* Scope.fork(scope, "sequential");
          const generation = ++nextGeneration;
          const preparation = yield* Effect.exit(
            Effect.gen(function* () {
              yield* fs.makeDirectory(path.dirname(target), { recursive: true });
              const subscription = yield* openAcknowledgedWatch(path.dirname(target)).pipe(
                Effect.provideService(NativeWatchFactory, nativeFactory),
                Effect.provideService(PrepareGate, prepareGate),
                Scope.provide(pending),
              );
              yield* subscription.ready;
              yield* reader(subscription.events, target, generation, pending, "target");
            }),
          );
          if (Exit.isFailure(preparation)) {
            yield* Scope.close(pending, Exit.void);
            return yield* Effect.failCause(preparation.cause);
          }
          replacement = { path: target, generation, scope: pending };
        }
        // The single actor waits for preparation and the new reader before closing the old lifetime.
        if (previous !== undefined) yield* Scope.close(previous.scope, Exit.void);
        yield* Ref.set(active, replacement);
        yield* observe(
          "committed",
          target ?? path.resolve(settingsPath),
          replacement?.generation ?? 0,
        );
      });
    const process = (signal: WatchSignal) =>
      Effect.gen(function* () {
        // This detects a repoint under the actor fence; it cannot atomically pin an external link.
        const target = yield* resolveTarget;
        const handoff = yield* Effect.exit(activate(target));
        if (Exit.isFailure(handoff)) {
          const retained = yield* Ref.get(active);
          yield* observe("replacement-refused", target ?? settingsPath, retained?.generation ?? 0);
          yield* Effect.logError("Settings link-target watch replacement refused", handoff.cause);
          return;
        }
        const current = yield* Ref.get(active);
        if (signal.source === "target" && signal.generation !== current?.generation) return;
        yield* revalidate.pipe(
          Effect.provideService(
            CommittedSettingsWatchPath,
            current?.path ?? path.resolve(settingsPath),
          ),
          Effect.ignoreCause({ log: true }),
        );
      }).pipe(Effect.ignoreCause({ log: true }));
    const bootstrap = Effect.gen(function* () {
      yield* fs
        .makeDirectory(path.dirname(settingsPath), { recursive: true })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ServerSettingsError({ settingsPath, operation: "prepare-directory", cause }),
          ),
        );
      yield* reader(fs.watch(path.dirname(settingsPath)), settingsPath, 0, scope, "directory");
      const initial = yield* Effect.exit(resolveTarget.pipe(Effect.flatMap(activate)));
      if (Exit.isFailure(initial)) {
        const platform = Cause.findErrorOption(initial.cause);
        return yield* Effect.fail(
          new LinkTargetRegistrationError({
            settingsPath,
            operation: "prepare-directory",
            cause: platform._tag === "Some" ? platform.value : initial.cause,
          }),
        );
      }
      yield* Stream.fromQueue(signals).pipe(
        Stream.debounce(Duration.millis(100)),
        Stream.runForEach(process),
        Effect.forkIn(scope),
      );
    });
    return Effect.gen(function* () {
      const first = yield* Ref.modify(started, (value) => [!value, true]);
      if (!first) return yield* Deferred.await(ready);
      const outcome = yield* Effect.exit(bootstrap);
      if (Exit.isFailure(outcome)) {
        yield* Scope.close(scope, Exit.void);
        yield* Deferred.failCause(ready, outcome.cause);
        return yield* Effect.failCause(outcome.cause);
      }
      yield* Deferred.succeed(ready, undefined);
    });
  });
