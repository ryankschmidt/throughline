import type { ModelSelection, OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { deriveReportedModelSelection } from "../state/threadExecution.ts";

export interface PendingComposerModel {
  readonly scope: string;
  readonly selection: ModelSelection;
  readonly observation: string;
  readonly runId: string | null;
}

export interface LiveComposerModelInput {
  readonly scope: string;
  readonly configured: ModelSelection;
  readonly reported: ModelSelection | null;
  readonly lastRequested: ModelSelection | null;
  readonly draft?: ModelSelection | null;
  readonly pending?: PendingComposerModel | null;
  readonly observation: string;
  readonly runId: string | null;
}

export function readLiveComposerObservation(projection: OrchestrationV2ThreadProjection | null) {
  const reported = projection ? deriveReportedModelSelection(projection) : null;
  const provider = projection?.providerThreads.find(
    (p) =>
      p.id === projection.thread.activeProviderThreadId &&
      p.providerInstanceId === projection.thread.modelSelection.instanceId,
  );
  const runs =
    projection?.runs.filter(
      (r) =>
        r.providerInstanceId === projection.thread.modelSelection.instanceId &&
        (r.providerThreadId === null || r.providerThreadId === provider?.id),
    ) ?? [];
  const latest = runs.reduce<(typeof runs)[number] | null>(
    (a, b) => (!a || b.ordinal > a.ordinal ? b : a),
    null,
  );
  return {
    reported,
    lastRequested: latest?.modelSelection ?? null,
    runId: latest?.id ?? null,
    // A run completing is not a new model observation. Only the owning
    // native metadata can consume the user's next-send choice.
    observation: JSON.stringify([provider?.id, provider?.nativeMetadata?.updatedAt, reported]),
  };
}

export function resolveLiveComposerModel(input: LiveComposerModelInput): ModelSelection {
  const same = (a: ModelSelection | null | undefined, b: ModelSelection | null | undefined) =>
    a != null &&
    b != null &&
    a.instanceId === b.instanceId &&
    a.model === b.model &&
    JSON.stringify(a.options ?? []) === JSON.stringify(b.options ?? []);
  const pending = input.pending;
  if (
    pending?.scope === input.scope &&
    (pending.observation === input.observation ||
      pending.runId === input.runId ||
      !same(pending.selection, input.lastRequested))
  )
    return pending.selection;
  // A saved choice matching the last dispatched request is consumed intent,
  // not a reason to conceal a provider-reported substitution indefinitely.
  if (input.draft && !same(input.draft, input.lastRequested)) return input.draft;
  if (input.lastRequested && !same(input.configured, input.lastRequested)) return input.configured;
  return input.reported?.instanceId === input.configured.instanceId
    ? input.reported
    : input.configured;
}
