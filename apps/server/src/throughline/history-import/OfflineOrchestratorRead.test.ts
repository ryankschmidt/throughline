// @effect-diagnostics nodeBuiltinImport:off - Inventory reads public source text only.
import { readFileSync } from "node:fs";
import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import type * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { OfflineImportRefusal, makeOfflineOrchestratorRead } from "./OfflineOrchestratorRead.ts";

it("schema decoding preserves the named refusal without a custom constructor", () => {
  const refusal = Schema.decodeUnknownSync(OfflineImportRefusal)({
    _tag: "OrchestratorProjectionError",
    threadId: "offline-refusal-not-a-thread",
    cause: "dispatch",
    operation: "dispatch",
  });
  expect(refusal.operation).toBe("dispatch");
  expect(refusal.message).toBe("Offline history import refuses dispatch.");
});

it("delegates the sole permitted read, including fields and filter", async () => {
  const calls: unknown[] = [];
  const result = { thread: { id: "test" } };
  const base = {
    getThreadRecords: (...args: unknown[]) =>
      Effect.sync(() => {
        calls.push(args);
        return result;
      }),
  } as unknown as ProjectionStore.ProjectionStoreV2Shape;
  const facade = makeOfflineOrchestratorRead(base);
  expect(await Effect.runPromise(facade.getThreadRecords(ThreadId.make("test"), []))).toBe(result);
  expect(calls).toEqual([["test", [], undefined]]);
});

it("inventories the public interface and refuses every non-read operation by name", async () => {
  const source = readFileSync(
    new URL("../../orchestration-v2/Orchestrator.ts", import.meta.url),
    "utf8",
  );
  const body = source
    .split("export interface OrchestratorV2Shape {")[1]!
    .split("\nexport class OrchestratorV2")[0]!;
  const keys = Array.from(body.matchAll(/^  readonly (\w+):/gm), (m) => m[1]!).sort();
  const facade = makeOfflineOrchestratorRead({} as ProjectionStore.ProjectionStoreV2Shape);
  expect(Object.keys(facade).sort()).toEqual(keys);
  const checks: Record<
    Exclude<keyof Orchestrator.OrchestratorV2Shape, "getThreadRecords">,
    () => Effect.Effect<unknown, Orchestrator.OrchestratorV2Error>
  > = {
    resumeQueuedRuns: () => facade.resumeQueuedRuns,
    recoverDelegatedTasks: () => facade.recoverDelegatedTasks,
    recoverDelegatedTask: () => facade.recoverDelegatedTask(undefined as never, undefined as never),
    delegatedTaskResultPending: () => facade.delegatedTaskResultPending(undefined as never),
    dispatch: () => facade.dispatch(undefined as never),
    searchThreadStream: () => Stream.runCollect(facade.searchThreadStream(undefined as never)),
    searchThread: () => facade.searchThread(undefined as never),
    getThreadHistoryPage: () => facade.getThreadHistoryPage(undefined as never, undefined as never),
    getTimelinePage: () => facade.getTimelinePage(undefined as never, undefined as never),
    getMessageCount: () => facade.getMessageCount(undefined as never),
    getTurnItem: () => facade.getTurnItem(undefined as never),
    getThreadProjection: () => facade.getThreadProjection(undefined as never),
    getCheckpointContext: () => facade.getCheckpointContext(undefined as never),
    getThreadSnapshot: () => facade.getThreadSnapshot(undefined as never),
    getThreadSnapshotWindow: () =>
      facade.getThreadSnapshotWindow(undefined as never, undefined as never),
    getThreadShell: () => facade.getThreadShell(undefined as never),
    getShellSnapshot: () => facade.getShellSnapshot(),
    readShellSnapshot: () => facade.readShellSnapshot(),
    getThreadEventSequence: () => facade.getThreadEventSequence(undefined as never),
    streamStoredEvents: () => Stream.runCollect(facade.streamStoredEvents),
    streamStoredEventsFrom: () => Stream.runCollect(facade.streamStoredEventsFrom()),
    streamDomainEvents: () => Stream.runCollect(facade.streamDomainEvents),
  };
  expect([...Object.keys(checks), "getThreadRecords"].sort()).toEqual(keys);
  for (const key of Object.keys(checks) as Array<keyof typeof checks>) {
    const exit = await Effect.runPromiseExit(checks[key]());
    expect(Exit.isFailure(exit), key).toBe(true);
    if (Exit.isFailure(exit)) {
      const refusal = Cause.squash(exit.cause);
      expect(refusal, key).toBeInstanceOf(OfflineImportRefusal);
      expect((refusal as OfflineImportRefusal).operation, key).toBe(key);
      expect((refusal as OfflineImportRefusal).message, key).toContain(
        "Offline history import refuses",
      );
    }
  }
  expect(keys.length).toBeGreaterThan(20);
});
