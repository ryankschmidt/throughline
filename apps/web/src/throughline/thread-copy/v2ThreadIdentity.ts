import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import type { ThreadCopyIdentity, ThreadCopyRef } from "./threadCopy";

/** Only the owning projection's strong native reference is copyable as native identity. */
export function identityFromV2Projection(
  ref: ThreadCopyRef,
  projection: OrchestrationV2ThreadProjection | null,
): ThreadCopyIdentity | null {
  if (!projection || projection.thread.id !== ref.threadId) return null;
  const providerThread = projection.providerThreads.find(
    (row) =>
      row.id === projection.thread.activeProviderThreadId && row.appThreadId === ref.threadId,
  );
  const nativeRef = providerThread?.nativeThreadRef;
  return {
    ...ref,
    session: {
      providerSessionId: providerThread?.providerSessionId ?? null,
      nativeSessionId: nativeRef?.strength === "strong" ? nativeRef.nativeId : null,
      // V2 does not publish this path. Never infer it from a UUID, provider or cwd.
      nativeTranscriptPath: null,
    },
  };
}
