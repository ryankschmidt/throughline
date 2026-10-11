import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Recovery from "../../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import { sweepOrphanedSessions, runOrphanedSessionSweep } from "./OrphanedSessionSweep.ts";

it.effect("orphan reconciliation uses the single upstream V2 recovery owner", () =>
  Effect.gen(function* () {
    const triggers: string[] = [];
    const summary = {
      terminalizedRuns: 2,
      stoppedSessions: 2,
      closedRequests: 0,
      retiredEffects: 0,
      requeuedEffects: 0,
    };
    const recovery = Recovery.ProviderRuntimeRecoveryService.of({
      reconcile: (trigger) =>
        Effect.sync(() => {
          triggers.push(trigger);
          return summary;
        }),
      recover: Effect.succeed(summary),
      prepareForShutdown: Effect.void,
    });
    assert.deepStrictEqual(
      yield* sweepOrphanedSessions.pipe(
        Effect.provideService(Recovery.ProviderRuntimeRecoveryService, recovery),
      ),
      summary,
    );
    assert.deepStrictEqual(triggers, ["startup"]);
  }),
);
it.effect("the compatibility sweep does not crash boot when recovery refuses", () =>
  Effect.gen(function* () {
    const recovery = Recovery.ProviderRuntimeRecoveryService.of({
      reconcile: () =>
        Effect.fail(
          new Recovery.ProviderRuntimeRecoveryError({
            operation: "reconcile",
            cause: "fixture refusal",
          }),
        ),
      recover: Effect.die("unused"),
      prepareForShutdown: Effect.void,
    });
    yield* runOrphanedSessionSweep.pipe(
      Effect.provideService(Recovery.ProviderRuntimeRecoveryService, recovery),
    );
  }),
);
