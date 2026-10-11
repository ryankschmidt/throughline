import * as Effect from "effect/Effect";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";

/** Test-only one-shot public capture-read fault; never mounted in production. */
export function faultCaptureReadOnce(
  base: ProjectionStore.ProjectionStoreV2Shape,
): ProjectionStore.ProjectionStoreV2Shape {
  let armed = true;
  return {
    ...base,
    getCheckpointCaptureContext: (threadId, target) =>
      Effect.suspend(() => {
        if (!armed) return base.getCheckpointCaptureContext(threadId, target);
        armed = false;
        return Effect.fail(
          new ProjectionStore.ProjectionStoreReadError({
            threadId,
            cause: "intentional retention admission failure",
          }),
        );
      }),
  };
}
