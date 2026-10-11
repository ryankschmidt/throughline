import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
export type ThreadCopyRef = { readonly environmentId: string; readonly threadId: string };
export type ThreadCopyIdentity = ThreadCopyRef & {
  readonly session?: {
    readonly providerSessionId?: string | null | undefined;
    readonly nativeSessionId?: string | null | undefined;
    readonly nativeTranscriptPath?: string | null | undefined;
  } | null;
};
export type ThreadCopyField = "thread" | "provider-session" | "native-session" | "transcript";

/** Only recorded native refs are copied; a provider row id is never a substitute. */
export function threadCopyIdentityFromV2(
  environmentId: string,
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "providerThreads">,
): ThreadCopyIdentity {
  const provider = projection.providerThreads.find(
    (row) => row.id === projection.thread.activeProviderThreadId,
  );
  return {
    environmentId,
    threadId: projection.thread.id,
    session: {
      providerSessionId: provider?.providerSessionId ?? null,
      nativeSessionId: provider?.nativeThreadRef?.nativeId ?? null,
      // V2's public projection exposes no recorded transcript path.
      nativeTranscriptPath: null,
    },
  };
}

function available(value: string | null | undefined): string | null {
  return value && value.trim().length > 0 ? value : null;
}

/** Values are supplied by the owning environment, never inferred from titles or paths. */
export function threadCopyItems(identity: ThreadCopyIdentity) {
  return [
    { field: "thread", label: "Copy thread ID", value: identity.threadId },
    {
      field: "provider-session",
      label: "Copy provider session ID",
      value: available(identity.session?.providerSessionId),
    },
    {
      field: "native-session",
      label: "Copy native session ID",
      value: available(identity.session?.nativeSessionId),
    },
    {
      field: "transcript",
      label: "Copy transcript path",
      value: available(identity.session?.nativeTranscriptPath),
    },
  ] as const;
}

export async function copyThreadValue(input: {
  readonly ref: ThreadCopyRef;
  readonly field: ThreadCopyField;
  readonly read: (ref: ThreadCopyRef) => ThreadCopyIdentity | null;
  readonly write: (value: string) => Promise<unknown>;
}): Promise<"copied" | "unavailable"> {
  const identity = input.read(input.ref);
  if (!identity) return "unavailable";
  if (
    identity.environmentId !== input.ref.environmentId ||
    identity.threadId !== input.ref.threadId
  ) {
    throw new Error("Thread identity does not match its owning environment and thread.");
  }
  const value = threadCopyItems(identity).find((item) => item.field === input.field)?.value;
  if (!value) return "unavailable";
  // Some platform adapters report an unsuccessful clipboard write as false.
  if ((await input.write(value)) === false) throw new Error("Clipboard did not accept the value.");
  return "copied";
}
