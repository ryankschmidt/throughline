// @effect-diagnostics nodeBuiltinImport:off - R3-11 owns synchronous native registration in this boundary only.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

const NodeFs = NodeFS;

export interface AcknowledgedWatch {
  readonly events: Stream.Stream<FileSystem.WatchEvent, PlatformError.PlatformError>;
  readonly ready: Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
}
const watchError = (directory: string, cause: unknown) => {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
  const syscall =
    typeof cause === "object" &&
    cause !== null &&
    "syscall" in cause &&
    typeof cause.syscall === "string"
      ? cause.syscall
      : undefined;
  return PlatformError.systemError({
    _tag:
      code === "ENOENT"
        ? "NotFound"
        : code === "EACCES" || code === "EPERM"
          ? "PermissionDenied"
          : code === "EEXIST"
            ? "AlreadyExists"
            : code === "EBUSY"
              ? "Busy"
              : code === "EISDIR" || code === "ENOTDIR" || code === "ELOOP"
                ? "BadResource"
                : "Unknown",
    module: "FileSystem",
    method: "watch",
    pathOrDescriptor: directory,
    cause,
    ...(syscall === undefined ? {} : { syscall }),
  });
};
/** Synchronous ownership transfer: native factories never suspend after opening. */
export type NativeWatchFactoryFn = (
  directory: string,
  listener: NodeFS.WatchListener<string>,
) => NodeFS.FSWatcher;
export const NativeWatchFactory = Context.Reference<NativeWatchFactoryFn>(
  "t3/throughline/settings-intent/NativeWatchFactory",
  {
    defaultValue: () => (directory, listener) =>
      NodeFs.watch(directory, { recursive: false }, listener),
  },
);
/** Test-only preparation hold, before acquisition; production uses the no-op default. */
export type PrepareGateFn = (directory: string) => Effect.Effect<void>;
export const PrepareGate = Context.Reference<PrepareGateFn>(
  "t3/throughline/settings-intent/PrepareGate",
  { defaultValue: () => () => Effect.void },
);
/** Owns registration and close, never settings content, cache, policy or secrets. */
export const openAcknowledgedWatch = (
  directory: string,
): Effect.Effect<AcknowledgedWatch, PlatformError.PlatformError, Scope.Scope> =>
  Effect.gen(function* () {
    const factory = yield* NativeWatchFactory;
    const prepare = yield* PrepareGate;
    yield* Effect.interruptible(prepare(directory));
    const queue = yield* Queue.make<
      FileSystem.WatchEvent,
      PlatformError.PlatformError | Cause.Done
    >();
    const ready = yield* Deferred.make<void>();
    let closed = false;
    const listener: NodeFS.WatchListener<string> = (kind, name) => {
      if (closed || !name) return;
      if (kind === "change") Queue.offerUnsafe(queue, { _tag: "Update", path: name });
      else
        NodeFs.stat(NodePath.resolve(directory, name), (error) => {
          if (!closed) Queue.offerUnsafe(queue, { _tag: error ? "Remove" : "Create", path: name });
        });
    };
    const watcher = yield* Effect.acquireRelease(
      Effect.try({
        try: () => factory(directory, listener),
        catch: (cause) => watchError(directory, cause),
      }).pipe(
        Effect.tap((watcher) =>
          Effect.sync(() => {
            watcher.on("error", (cause) =>
              Queue.failCauseUnsafe(
                queue,
                Cause.fail(
                  PlatformError.systemError({
                    _tag: "Unknown",
                    module: "FileSystem",
                    method: "watch",
                    pathOrDescriptor: directory,
                    cause,
                  }),
                ),
              ),
            );
            watcher.on("close", () => Queue.endUnsafe(queue));
            Deferred.doneUnsafe(ready, Effect.void);
          }),
        ),
      ),
      (watcher) =>
        Effect.sync(() => {
          if (!closed) {
            closed = true;
            watcher.close();
          }
          Queue.shutdownUnsafe(queue);
        }),
    );
    return {
      events: Stream.fromQueue(queue),
      ready: Deferred.await(ready),
      close: Effect.sync(() => {
        if (!closed) {
          closed = true;
          watcher.close();
        }
        Queue.shutdownUnsafe(queue);
      }),
    };
  });
