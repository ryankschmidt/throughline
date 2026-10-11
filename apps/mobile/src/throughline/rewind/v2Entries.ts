import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** Prompt identity comes from V2 user items, never a file checkpoint or list index. */
export function buildV2RewindEntries(projection: OrchestrationV2ThreadProjection | null) {
  if (!projection) return [];
  const entries = projection.visibleTurnItems.flatMap(({ item }) => {
    if (item.type !== "user_message") return [];
    const checkpoint = projection.checkpoints.find((row) => row.runId === item.runId);
    const parent = checkpoint?.parentCheckpointId
      ? projection.checkpoints.find(
          (row) => row.id === checkpoint.parentCheckpointId && row.status === "ready",
        )
      : undefined;
    const fileCheckpoint =
      item.inputIntent === "steer" || item.inputIntent === "promoted_queued_to_steer"
        ? undefined
        : parent;
    return [
      {
        id: item.messageId,
        text: item.text,
        attachments: item.attachments,
        createdAt: DateTime.formatIso(
          projection.messages.find((message) => message.id === item.messageId)?.createdAt ??
            item.startedAt ??
            item.updatedAt,
        ),
        runId: item.runId,
        fileCheckpoint: fileCheckpoint
          ? { checkpointId: fileCheckpoint.id, scopeId: fileCheckpoint.scopeId }
          : null,
        unavailableReason: fileCheckpoint
          ? null
          : "No file-checkpoint boundary. Conversation-only requests fail closed if unsupported by the host.",
      },
    ];
  });
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}

export type V2RewindEntry = ReturnType<typeof buildV2RewindEntries>[number];
