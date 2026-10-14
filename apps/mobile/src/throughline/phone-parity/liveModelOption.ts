import type { ModelSelection, ServerConfig } from "@t3tools/contracts";

import type { ModelOption } from "../../lib/modelOptions";

/**
 * The phone twin of the desktop's `withLiveComposerPickerOption`
 * (apps/web/src/throughline/composer/ComposerCarry.tsx): when the catalog omits the
 * thread's live model (retired or hidden), keep it visible under its own provider,
 * tagged unavailable, so the picker shows what the thread actually runs. Presentation
 * only; unavailable rows cannot be chosen.
 */
export function withLiveModelOption(
  options: ReadonlyArray<ModelOption>,
  selection: ModelSelection,
  config: ServerConfig | null | undefined,
): ReadonlyArray<ModelOption> {
  if (
    options.some(
      (option) =>
        option.selection.instanceId === selection.instanceId &&
        option.selection.model === selection.model,
    )
  ) {
    return options;
  }
  const provider = config?.providers.find((entry) => entry.instanceId === selection.instanceId);
  const instance = config?.settings?.providerInstances[selection.instanceId];
  const providerDriver = provider?.driver ?? instance?.driver ?? selection.instanceId;
  const sibling = options.find((option) => option.providerKey === selection.instanceId);
  const iconUrl = provider?.iconUrl ?? sibling?.providerIconUrl;
  return [
    ...options,
    {
      key: `${selection.instanceId}:${selection.model}`,
      label: selection.model,
      subtitle: "",
      providerKey: selection.instanceId,
      providerLabel:
        sibling?.providerLabel ??
        provider?.displayName ??
        instance?.displayName ??
        selection.instanceId,
      providerDriver,
      ...(iconUrl ? { providerIconUrl: iconUrl } : {}),
      isDefault: false,
      isLegacy: false,
      isUnavailable: true,
      capabilities: null,
      selection,
    },
  ];
}
