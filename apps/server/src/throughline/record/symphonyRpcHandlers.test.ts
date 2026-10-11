import { assert, it } from "@effect/vitest";
import {
  AbsurdRuntime,
  SYMPHONY_QUEUE,
  THREAD_RUN_TASK,
  type AbsurdRuntimeHandle,
} from "@t3tools/absurd-runtime";
import { SYMPHONY_WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { makeSymphonyRpcHandlers } from "./symphonyRpcHandlers.ts";

const projects = Layer.mock(ProjectStore.ProjectStoreV2)({
  get: () => Effect.succeed(Option.some({} as ProjectStore.ProjectRow)),
});

it.effect("refuses Symphony spawn and status with no mounted worker", () =>
  Effect.gen(function* () {
    const handlers = yield* makeSymphonyRpcHandlers;
    assert.isFalse((yield* handlers[SYMPHONY_WS_METHODS.runtimeReady]()).ready);
    assert.equal(
      (yield* Effect.flip(
        handlers[SYMPHONY_WS_METHODS.spawnThreadRun]({
          prompt: "fixture",
          model: "gpt-5.4",
          holdMs: 1,
        }),
      ))._tag,
      "RuntimeNotReady",
    );
    assert.equal(
      (yield* Effect.flip(handlers[SYMPHONY_WS_METHODS.taskStatus]({ taskID: "missing" })))._tag,
      "SymphonyRuntimeUnavailableError",
    );
  }).pipe(Effect.provide(projects)),
);

it.effect("spawns only on the dedicated worker and reads queue-scoped actual results", () =>
  Effect.gen(function* () {
    vi.stubEnv("T3_SYMPHONY_PROJECT_ID", "fixture-project");
    yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
    const spawn = vi.fn(async () => ({ taskID: "actual-fixture-task" }));
    const fetch = vi.fn(async () => ({
      state: "completed" as const,
      result: { summary: "actual result" },
    }));
    // Only the worker handle's external calls are fixture ports; readiness and
    // handler decisions are the production functions, with no database/server.
    const runtime = {
      queueName: "t3-interactive-turns",
      app: {
        listQueues: async () => ["t3-interactive-turns", SYMPHONY_QUEUE],
        fetchTaskResult: fetch,
      },
      symphonyQueue: {
        queueName: SYMPHONY_QUEUE,
        app: { listQueues: async () => [SYMPHONY_QUEUE], spawn },
      },
    } as unknown as AbsurdRuntimeHandle;
    const handlers = yield* makeSymphonyRpcHandlers.pipe(
      Effect.provideService(AbsurdRuntime, runtime),
    );
    assert.isTrue((yield* handlers[SYMPHONY_WS_METHODS.runtimeReady]()).ready);
    assert.deepEqual(
      yield* handlers[SYMPHONY_WS_METHODS.spawnThreadRun]({
        prompt: "fixture",
        model: "gpt-5.4",
        holdMs: 1,
      }),
      { taskID: "actual-fixture-task" },
    );
    assert.deepEqual(spawn.mock.calls[0], [
      THREAD_RUN_TASK,
      { prompt: "fixture", model: "gpt-5.4", holdMs: 1 },
      { queue: SYMPHONY_QUEUE },
    ]);
    assert.deepEqual(
      yield* handlers[SYMPHONY_WS_METHODS.taskStatus]({ taskID: "actual-fixture-task" }),
      { state: "completed", resultSummary: "actual result" },
    );
    assert.deepEqual(fetch.mock.calls[0], ["actual-fixture-task", { queue: SYMPHONY_QUEUE }]);
    assert.equal(
      (yield* Effect.flip(
        handlers[SYMPHONY_WS_METHODS.spawnThreadRun]({
          prompt: "fixture",
          model: "off-table",
          holdMs: 1,
        }),
      ))._tag,
      "SymphonySpawnError",
    );
    assert.equal(spawn.mock.calls.length, 1);
  }).pipe(Effect.scoped, Effect.provide(projects)),
);
