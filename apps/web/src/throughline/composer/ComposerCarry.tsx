import { resolveCarriedComposerMenu } from "./carriedComposerPolicy";
import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import type { ModelEsque } from "../../components/chat/providerIconUtils";
export {
  readLiveComposerObservation,
  resolveLiveComposerModel,
  type PendingComposerModel,
} from "@t3tools/client-runtime/throughline/live-composer-model";

export function resolveChatComposerDispatchModel(
  selection: ModelSelection,
  reported: ModelSelection | null,
  draftOptions: Parameters<typeof createModelSelection>[2],
): ModelSelection {
  // Native omissions stay omitted, and explicit full selections keep their
  // options. Only unresolved composer intent uses the existing public converter.
  return selection === reported || selection.options !== undefined
    ? selection
    : createModelSelection(selection.instanceId, selection.model, draftOptions);
}

export function withLiveComposerPickerOption(
  options: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>,
  selection: ModelSelection,
): ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>> {
  const current = options.get(selection.instanceId) ?? [];
  if (current.some((option) => option.slug === selection.model)) return options;
  // Presentation only; the paired disabled-reason adapter prevents this
  // observed identity from becoming a new selectable catalog entry.
  return new Map(options).set(selection.instanceId, [
    ...current,
    { slug: selection.model, name: selection.model, isUnavailable: true },
  ]);
}

export function liveComposerPickerDisabledReason(
  options: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>,
  selection: ModelSelection,
  instanceId: ProviderInstanceId,
  model: string,
): string | null {
  return instanceId === selection.instanceId &&
    model === selection.model &&
    !(options.get(instanceId) ?? []).some((option) => option.slug === model)
    ? "This active model is not in the current catalog."
    : null;
}

export function resolveChatComposerLocalMenu(
  input: Parameters<typeof resolveCarriedComposerMenu>[0] & {
    routeKind: string;
    hasPendingProgress: boolean;
  },
): "rewind" | "config" | null {
  return input.routeKind === "server" && !input.hasPendingProgress
    ? resolveCarriedComposerMenu(input)
    : null;
}
