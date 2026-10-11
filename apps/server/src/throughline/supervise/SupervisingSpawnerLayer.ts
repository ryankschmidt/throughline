import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

export interface SupervisedBinding {
  readonly threadId: string;
  readonly cwd: string;
  readonly acquire: Effect.Effect<
    ChildProcessSpawner.ChildProcessHandle,
    PlatformError.PlatformError,
    Scope.Scope
  >;
}
/** Supplied by the process owner, not by a tool's arguments or a claimed PID. */
export const CurrentSupervisedBinding = Context.Reference<SupervisedBinding | undefined>(
  "ThroughLine/SupervisedBinding",
  { defaultValue: () => undefined },
);
export const CurrentSpawnIdentity = Context.Reference<
  | { readonly threadId: string; readonly cwd: string; readonly supervisionRequired: boolean }
  | undefined
>("ThroughLine/SpawnIdentity", { defaultValue: () => undefined });
const mismatch = () =>
  PlatformError.badArgument({
    module: "SupervisingSpawner",
    method: "spawn",
    description: "SUPERVISED_PROCESS_BINDING_MISMATCH",
  });

export const makeSupervisingSpawner = (base: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const binding = yield* CurrentSupervisedBinding;
      const identity = yield* CurrentSpawnIdentity;
      if (!binding)
        return identity?.supervisionRequired ? yield* mismatch() : yield* base.spawn(command);
      if (
        !identity ||
        binding.threadId !== identity.threadId ||
        binding.cwd !== identity.cwd ||
        !ChildProcess.isStandardCommand(command) ||
        command.options.cwd !== binding.cwd ||
        !Effect.isEffect(binding.acquire)
      ) {
        return yield* mismatch();
      }
      return yield* binding.acquire;
    }),
  );

export const layer = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.map(ChildProcessSpawner.ChildProcessSpawner, makeSupervisingSpawner),
);
