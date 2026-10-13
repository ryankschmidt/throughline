import { cloneElement, isValidElement, type ComponentProps, type ReactNode } from "react";
import type { ModelSelection } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import type { PendingComposerModel } from "@t3tools/client-runtime/throughline/live-composer-model";
import { TraitsMenuContent, TraitsPicker } from "../../components/chat/TraitsPicker";

type Options = ModelSelection["options"];

/** Bind to the actual submit snapshot, never refresh the observation/run marker. */
export function bindPendingComposerRequest(
  pending: PendingComposerModel | null,
  scope: string,
  request: ModelSelection,
): PendingComposerModel | null {
  if (
    !pending ||
    pending.scope !== scope ||
    pending.selection.instanceId !== request.instanceId ||
    pending.selection.model !== request.model
  )
    return pending;
  // A newer explicit option choice must not be overwritten by an older send.
  if (
    pending.selection.options !== undefined &&
    JSON.stringify(pending.selection.options) !== JSON.stringify(request.options ?? [])
  )
    return pending;
  return pending.selection === request ? pending : { ...pending, selection: request };
}

export function persistLiveComposerOptions(
  current: ModelSelection,
  options: Options,
  ports: {
    seed: (selection: ModelSelection) => void;
    applyOptions: (options: Options) => void;
    read: () => ModelSelection | undefined;
  },
): ModelSelection {
  // Seed the complete displayed identity through the public setter, then
  // preserve the stock option/sticky persistence path.
  ports.seed(current);
  ports.applyOptions(options);
  return ports.read() ?? createModelSelection(current.instanceId, current.model, options);
}

/** Reuse the public stock control/guard/style; replace only its persistence port. */
export function withLiveTraitsPersistence(
  control: ReactNode,
  change: (options: Options) => void,
): ReactNode {
  if (control === null) return null;
  if (
    !isValidElement<ComponentProps<typeof TraitsPicker>>(control) ||
    (control.type !== TraitsPicker && control.type !== TraitsMenuContent)
  ) {
    throw new Error("Unexpected public traits control");
  }
  return cloneElement(control, {
    threadRef: undefined,
    onModelOptionsChange: change,
  });
}
