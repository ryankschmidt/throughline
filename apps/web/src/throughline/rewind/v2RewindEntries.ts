import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export type V2RewindProjection = Pick<
  OrchestrationV2ThreadProjection,
  "messages" | "runs" | "checkpoints" | "checkpointScopes"
>;

/** Ready, explicit v2 checkpoint targets only; no synthetic native message boundaries. */
export function buildV2RewindEntries(projection: V2RewindProjection | null | undefined) {
  if (!projection) return [];
  return projection.messages.flatMap((message) => {
    if (message.role !== "user") return [];
    const run = projection.runs.find((candidate) => candidate.id === message.runId);
    if (run?.status === "rolled_back") return [];
    const scope = run
      ? projection.checkpointScopes.find(
          (candidate) =>
            candidate.kind === "root_run" && candidate.providerThreadId === run.providerThreadId,
        )
      : undefined;
    const checkpoint =
      run && run.userMessageId === message.id && scope
        ? projection.checkpoints.findLast(
            (candidate) =>
              candidate.scopeId === scope.id &&
              candidate.status === "ready" &&
              (run.ordinal === 1
                ? candidate.ordinalWithinScope === 0 && candidate.appRunOrdinal === null
                : candidate.appRunOrdinal === run.ordinal - 1),
          )
        : undefined;
    return [
      {
        id: message.id,
        text: message.text,
        createdAt: DateTime.formatIso(message.createdAt),
        runId: run?.id ?? null,
        turnCount: run ? run.ordinal - 1 : null,
        checkpointId: checkpoint?.id ?? null,
        scopeId: checkpoint?.scopeId ?? null,
        unavailableReason: checkpoint
          ? null
          : "Exact-message rewind without a ready checkpoint is not supported by this server yet.",
      },
    ];
  });
}

export type V2RewindEntry = ReturnType<typeof buildV2RewindEntries>[number];

export function checkpointRequestForEntry(entry: V2RewindEntry, restoreFiles = false) {
  if (!entry.checkpointId || !entry.scopeId || entry.unavailableReason) {
    throw new Error(entry.unavailableReason ?? "The rewind checkpoint is unavailable.");
  }
  return { checkpointId: entry.checkpointId, scopeId: entry.scopeId, restoreFiles };
}
