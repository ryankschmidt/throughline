import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

/** Presentation-only: never delete source items or match ordinary user/assistant text. */
export function mobileConversationItemVisible(item: OrchestrationV2TurnItem): boolean {
  if (item.type === "notification") {
    // Stopped internal task plumbing is not chat. Keep actual monitor updates,
    // failures, commands and subagent results visible rather than hiding warnings.
    return (
      item.outcome !== "cancelled" ||
      (item.source.kind !== "monitor" && item.source.kind !== "background_task")
    );
  }
  if (item.type === "system_notice") {
    return !/^Claude system message ui_status(?:\s*[—:-]\s*[^\n]*)?$/.test(item.message.trim());
  }
  return true;
}
