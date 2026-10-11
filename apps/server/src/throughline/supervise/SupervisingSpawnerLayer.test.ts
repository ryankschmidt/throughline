// @effect-diagnostics nodeBuiltinImport:off - This test owns its captured fixture child only.
import { assert, it } from "@effect/vitest";
import { spawn } from "node:child_process";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { makeSupervisedProcessHandle } from "./SupervisedProcess.ts";
import {
  CurrentSpawnIdentity,
  CurrentSupervisedBinding,
  makeSupervisingSpawner,
} from "./SupervisingSpawnerLayer.ts";

it.effect(
  "selects the granted captured child on a matching binding, never the fallback executable",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const child = spawn(process.execPath, ["-e", "setTimeout(()=>process.exit(0),100)"], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve) => child.once("exit", (code, signal) => resolve({ code, signal })),
        );
        const binding = {
          threadId: "thread",
          cwd: process.cwd(),
          acquire: makeSupervisedProcessHandle({
            pid: child.pid!,
            input: child.stdin,
            output: child.stdout,
            error: child.stderr,
            exit,
            isRunning: async () => child.exitCode === null && child.signalCode === null,
            stop: async () => {
              if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
              await exit;
            },
          }),
        };
        const base = ChildProcessSpawner.make(() => Effect.die("fallback must not run"));
        const spawner = makeSupervisingSpawner(base);
        const handle = yield* spawner
          .spawn(ChildProcess.make("/deliberately-absent", { cwd: process.cwd() }))
          .pipe(
            Effect.provideService(CurrentSupervisedBinding, binding),
            Effect.provideService(CurrentSpawnIdentity, {
              threadId: "thread",
              cwd: process.cwd(),
              supervisionRequired: true,
            }),
          );
        assert.strictEqual(handle.pid, child.pid);
        assert.strictEqual(yield* handle.exitCode, 0);
      }),
    ),
);

it.effect("mismatched and missing required grants refuse before fallback or acquisition", () =>
  Effect.gen(function* () {
    let fallback = 0,
      acquired = 0;
    const base = ChildProcessSpawner.make(() =>
      Effect.sync(() => {
        fallback++;
        throw new Error("unexpected fallback");
      }),
    );
    const spawner = makeSupervisingSpawner(base);
    const identity = { threadId: "thread", cwd: process.cwd(), supervisionRequired: true };
    const command = ChildProcess.make("fixture", { cwd: process.cwd() });
    const mismatch = yield* Effect.flip(
      spawner.spawn(command).pipe(
        Effect.provideService(CurrentSpawnIdentity, identity),
        Effect.provideService(CurrentSupervisedBinding, {
          threadId: "other",
          cwd: process.cwd(),
          acquire: Effect.sync(() => {
            acquired++;
            throw new Error("unexpected acquisition");
          }),
        }),
      ),
    );
    assert.include(mismatch.message, "SUPERVISED_PROCESS_BINDING_MISMATCH");
    const missing = yield* Effect.flip(
      spawner.spawn(command).pipe(Effect.provideService(CurrentSpawnIdentity, identity)),
    );
    assert.include(missing.message, "SUPERVISED_PROCESS_BINDING_MISMATCH");
    assert.strictEqual(fallback, 0);
    assert.strictEqual(acquired, 0);
  }),
);

it.effect("an unbound ordinary spawn retains the original spawner", () =>
  Effect.gen(function* () {
    let called = 0;
    const base = ChildProcessSpawner.make(() =>
      Effect.sync(() => {
        called++;
        return undefined;
      }).pipe(
        Effect.andThen(
          Effect.fail(
            PlatformError.badArgument({
              module: "fixture",
              method: "base",
              description: "base selected",
            }),
          ),
        ),
      ),
    );
    const failure = yield* Effect.flip(
      makeSupervisingSpawner(base).spawn(ChildProcess.make("fixture")),
    );
    assert.include(failure.message, "base selected");
    assert.strictEqual(called, 1);
  }),
);
