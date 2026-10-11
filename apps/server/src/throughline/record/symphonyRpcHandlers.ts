import { AbsurdRuntime, SYMPHONY_QUEUE, THREAD_RUN_TASK } from "@t3tools/absurd-runtime";
import {
  ProjectId,
  RuntimeNotReady,
  SYMPHONY_WS_METHODS,
  SymphonySpawnError,
  SymphonyRuntimeUnavailableError,
  SymphonyTaskStatusError,
  type SymphonySpawnThreadRunInput,
  type SymphonyTaskStatusInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import {
  assertRoutedSymphonyModel,
  mapSymphonyTaskSnapshot,
  resolveSymphonyRuntime,
} from "./symphonyHandlers.ts";
import {
  computeRuntimeReadiness,
  makeQueueReachabilityProbe,
  makeSessionBoundaryProbe,
  readinessBlockingChecks,
} from "./runtimeReadiness.ts";

// Existing fork RPC behavior, composed through V2's public project store.
export const makeSymphonyRpcHandlers = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const runtimeOption = yield* Effect.serviceOption(AbsurdRuntime);
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);
  const readinessDeps = {
    absurdRuntime: runtimeOption,
    probeQueueReachable: makeQueueReachabilityProbe(),
    sessionBoundaryState: makeSessionBoundaryProbe({
      symphonyQueueHandle: runtimeOption.pipe(
        Option.flatMap((handle) => Option.fromUndefinedOr(handle.symphonyQueue)),
      ),
      probeSymphonyQueueReachable: makeQueueReachabilityProbe(),
      symphonyProjectId: process.env.T3_SYMPHONY_PROJECT_ID ?? "",
      projectExists: (raw: string) => {
        const project = Schema.decodeUnknownOption(ProjectId)(raw);
        if (Option.isNone(project)) return Promise.resolve(false);
        return runPromise(
          projects.get(project.value).pipe(
            Effect.map(Option.isSome),
            Effect.timeout("2 seconds"),
            Effect.orElseSucceed(() => false),
          ),
        );
      },
    }),
  };
  return {
    [SYMPHONY_WS_METHODS.runtimeReady]: () =>
      Effect.promise(() => computeRuntimeReadiness(readinessDeps)),
    [SYMPHONY_WS_METHODS.spawnThreadRun]: (request: SymphonySpawnThreadRunInput) =>
      Effect.gen(function* () {
        const readiness = yield* Effect.promise(() => computeRuntimeReadiness(readinessDeps));
        const blocking = readinessBlockingChecks(readiness);
        if (blocking.length > 0)
          return yield* new RuntimeNotReady({
            message: `Symphony runtime not ready: ${blocking.join(", ")}`,
            notReady: blocking,
          });
        const runtime = yield* resolveSymphonyRuntime(runtimeOption);
        yield* assertRoutedSymphonyModel(request.model);
        const app = runtime.symphonyQueue?.app;
        if (app === undefined)
          return yield* new SymphonyRuntimeUnavailableError({
            message: "Symphony queue worker is unavailable; symphony spawn failed closed.",
          });
        const spawned = yield* Effect.tryPromise({
          try: () =>
            app.spawn(
              THREAD_RUN_TASK,
              { prompt: request.prompt, model: request.model, holdMs: request.holdMs },
              { queue: SYMPHONY_QUEUE },
            ),
          catch: (cause) =>
            new SymphonySpawnError({ message: "Failed to spawn symphony thread-run", cause }),
        });
        return { taskID: spawned.taskID };
      }),
    [SYMPHONY_WS_METHODS.taskStatus]: (input: SymphonyTaskStatusInput) =>
      Effect.gen(function* () {
        const runtime = yield* resolveSymphonyRuntime(runtimeOption);
        const snapshot = yield* Effect.tryPromise({
          try: () => runtime.app.fetchTaskResult(input.taskID, { queue: SYMPHONY_QUEUE }),
          catch: (cause) =>
            new SymphonyTaskStatusError({ message: "Failed to read symphony task status", cause }),
        });
        if (snapshot === null)
          return yield* new SymphonyTaskStatusError({
            message: `Unknown symphony task: ${input.taskID}`,
          });
        return mapSymphonyTaskSnapshot(snapshot);
      }),
  };
});
