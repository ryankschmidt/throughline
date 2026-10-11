import {
  assertQueuedCaptureAfterCut,
  assertLostProviderOwnershipAfterCut,
} from "./testing/CheckpointHarness.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as Capture from "../../orchestration-v2/CheckpointCaptureService.ts";
import { faultCaptureReadOnce } from "./testing/FaultingProjectionStore.ts";
import {
  fixture,
  threadId,
  runId,
  scopeId,
  assertDelayedCaptureAfterCut,
  assertCaptureThenCut,
  assertStillValidBlockedCapture,
  assertOriginalRewindGuard,
  assertNewPostCutCapture,
} from "./testing/CheckpointHarness.ts";

it.effect(
  "checkpoint-contention V2: a still-valid waiting capture publishes through real SQLite and Git",
  () =>
    fixture(
      Effect.gen(function* () {
        yield* (yield* Capture.CheckpointCaptureServiceV2).execute({ threadId, runId, scopeId });
        const records = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadRecords(
          threadId,
          ["runs", "checkpoints"],
        );
        const captured = records.checkpoints.find((c) => c.runId === runId);
        assert.equal(captured?.status, "ready");
        assert.equal(records.runs[0]?.checkpointId, captured?.id);
        assert.equal(records.runs[0]?.status, "completed");
      }),
    ),
);

it.effect(
  "checkpoint-contention V2: an in-flight filesystem capture cannot publish after the exact HTTP cut",
  assertDelayedCaptureAfterCut,
);

it.effect(
  "checkpoint-contention V2: a public capture-read failure is loud and the next capture progresses",
  () =>
    fixture(
      Effect.gen(function* () {
        const real = yield* ProjectionStore.ProjectionStoreV2;
        const fault = faultCaptureReadOnce(real);
        // Fresh capture constructor: the outer harness already memoized the stock
        // capture layer, so reusing that same layer would silently bypass the fault.
        const captureLayer = Layer.fresh(Capture.layer).pipe(
          Layer.provide(Layer.succeed(ProjectionStore.ProjectionStoreV2, fault)),
        );
        yield* Effect.gen(function* () {
          const capture = yield* Capture.CheckpointCaptureServiceV2;
          const error = yield* capture.execute({ threadId, runId, scopeId }).pipe(Effect.flip);
          assert.instanceOf(error, Capture.CheckpointCaptureExecutionError);
          assert.include(String(error.cause), "Failed to read orchestration projection");
          yield* capture.execute({ threadId, runId, scopeId });
        }).pipe(Effect.provide(captureLayer));
        const records = yield* real.getThreadRecords(threadId, ["checkpoints"]);
        assert.equal(records.checkpoints.filter((c) => c.runId === runId).length, 1);
      }),
    ),
);

it.effect(
  "checkpoint-contention V2: a capture committed before the exact cut leaves no live removed-run checkpoint",
  assertCaptureThenCut,
);

it.effect.each([false, true])(
  "checkpoint-contention V2: exact cut precedes queued capture, queued=%s",
  (queued) => assertQueuedCaptureAfterCut(queued),
);
it.effect.each(["run", "provider"] as const)(
  "checkpoint-contention V2: lost %s ownership cannot publish a removed completion",
  (guard) => assertLostProviderOwnershipAfterCut(guard),
);

it.effect.each([
  "retained-message-less",
  "failed-provider-rollback",
  "older-retained-completion",
] as const)(
  "checkpoint-contention V2: a still-valid blocked capture publishes, case=%s",
  assertStillValidBlockedCapture,
);

it.effect.each(["missing", "assistant", "starting", "running"] as const)(
  "checkpoint-contention V2: exact rewind rejects invalid boundary or active session, guard=%s",
  assertOriginalRewindGuard,
);

it.effect(
  "checkpoint-contention V2: a genuinely new post-cut intake run captures normally",
  assertNewPostCutCapture,
);
