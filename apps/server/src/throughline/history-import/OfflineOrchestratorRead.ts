import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";

/** Uses the public error family; no foreign error is laundered into its contract. */
export class OfflineImportRefusal extends Orchestrator.OrchestratorProjectionError.extend<OfflineImportRefusal>(
  "OfflineImportRefusal",
)({ operation: Schema.String }) {
  static forOperation(operation: string) {
    return new OfflineImportRefusal({
      threadId: ThreadId.make("offline-refusal-not-a-thread"),
      cause: operation,
      operation,
    });
  }
  override get message() {
    return `Offline history import refuses ${this.operation}.`;
  }
}

export const makeOfflineOrchestratorRead = (
  projection: ProjectionStore.ProjectionStoreV2Shape,
): Orchestrator.OrchestratorV2Shape => {
  const refused = (operation: string) => Effect.fail(OfflineImportRefusal.forOperation(operation));
  const refusedStream = (operation: string) =>
    Stream.fail(OfflineImportRefusal.forOperation(operation));
  return {
    getThreadRecords: (id, fields, filter) =>
      projection
        .getThreadRecords(id, fields, filter)
        .pipe(
          Effect.mapError(
            (cause) => new Orchestrator.OrchestratorProjectionError({ threadId: id, cause }),
          ),
        ),
    resumeQueuedRuns: refused("resumeQueuedRuns"),
    // These two upstream methods have a never error channel. A typed named
    // refusal is a defect, not a successful no-op or a lied-about signature.
    recoverDelegatedTasks: Effect.die(OfflineImportRefusal.forOperation("recoverDelegatedTasks")),
    recoverDelegatedTask: () =>
      Effect.die(OfflineImportRefusal.forOperation("recoverDelegatedTask")),
    delegatedTaskResultPending: () => refused("delegatedTaskResultPending"),
    dispatch: () => refused("dispatch"),
    searchThreadStream: () => refusedStream("searchThreadStream"),
    searchThread: () => refused("searchThread"),
    getThreadHistoryPage: () => refused("getThreadHistoryPage"),
    getTimelinePage: () => refused("getTimelinePage"),
    getMessageCount: () => refused("getMessageCount"),
    getTurnItem: () => refused("getTurnItem"),
    getThreadProjection: () => refused("getThreadProjection"),
    getCheckpointContext: () => refused("getCheckpointContext"),
    getThreadSnapshot: () => refused("getThreadSnapshot"),
    getThreadSnapshotWindow: () => refused("getThreadSnapshotWindow"),
    getThreadShell: () => refused("getThreadShell"),
    getShellSnapshot: () => refused("getShellSnapshot"),
    readShellSnapshot: () => refused("readShellSnapshot"),
    getThreadEventSequence: () => refused("getThreadEventSequence"),
    streamStoredEvents: refusedStream("streamStoredEvents"),
    streamStoredEventsFrom: () => refusedStream("streamStoredEventsFrom"),
    streamDomainEvents: refusedStream("streamDomainEvents"),
  };
};
export const layer = Layer.effect(
  Orchestrator.OrchestratorV2,
  Effect.map(ProjectionStore.ProjectionStoreV2, makeOfflineOrchestratorRead),
);
