export interface MenuIdentityProjection {
  readonly thread: { readonly id: string; readonly activeProviderThreadId: string | null };
  readonly providerThreads: ReadonlyArray<{
    readonly id: string;
    readonly appThreadId: string | null;
    readonly nativeThreadRef: {
      readonly strength: string;
      readonly nativeId: string | null;
    } | null;
  }>;
}
export function nativeMenuSessionUuid(
  threadId: string,
  projection: MenuIdentityProjection | null,
): string | null {
  if (!projection || projection.thread.id !== threadId) return null;
  const provider = projection.providerThreads.find(
    (row) => row.id === projection.thread.activeProviderThreadId && row.appThreadId === threadId,
  );
  return provider?.nativeThreadRef?.strength === "strong"
    ? provider.nativeThreadRef.nativeId
    : null;
}
