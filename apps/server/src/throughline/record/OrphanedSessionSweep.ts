import * as Effect from "effect/Effect";
import * as Recovery from "../../orchestration-v2/ProviderRuntimeRecoveryService.ts";

// Upstream V2 owns the persisted run/session reconciliation now. No parallel V1 engine.
export const sweepOrphanedSessions = Effect.flatMap(
  Recovery.ProviderRuntimeRecoveryService,
  (recovery) => recovery.reconcile("startup"),
);
export const runOrphanedSessionSweep = sweepOrphanedSessions.pipe(
  Effect.asVoid,
  Effect.catchCause(() =>
    Effect.logWarning("Orphaned-session recovery failed; its V2 state remains authoritative."),
  ),
);
