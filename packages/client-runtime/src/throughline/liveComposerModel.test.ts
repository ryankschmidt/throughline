import { describe, expect, it } from "vite-plus/test";
import {
  MessageId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderSessionId,
  ProviderDriverKind,
  RunId,
  type ModelSelection,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import {
  readLiveComposerObservation,
  resolveLiveComposerModel,
  type LiveComposerModelInput,
} from "./liveComposerModel.ts";
import { v2Projection, v2Now } from "../state/orchestrationV2TestFixtures.ts";

const model = (name: string, account = "claudeAgent"): ModelSelection => ({
  instanceId: ProviderInstanceId.make(account),
  model: name,
});
const input: LiveComposerModelInput = {
  scope: "mac:thread-1",
  configured: model("requested-A"),
  reported: model("answered-B"),
  lastRequested: model("requested-A"),
  observation: "answer-1",
  runId: "run-1",
};

describe("live composer picker and next-dispatch selection", () => {
  it("uses the observed live model instead of the stale requested/default model", () => {
    expect(resolveLiveComposerModel(input)).toEqual(model("answered-B"));
  });
  it("does not let a consumed sticky draft conceal the observed model", () => {
    expect(resolveLiveComposerModel({ ...input, draft: model("requested-A") })).toEqual(
      model("answered-B"),
    );
  });
  it("uses a new draft choice for both picker and next dispatch", () => {
    expect(resolveLiveComposerModel({ ...input, draft: model("next-C") })).toEqual(model("next-C"));
  });
  it("honors a deliberate re-selection of the previously substituted request", () => {
    expect(
      resolveLiveComposerModel({
        ...input,
        pending: {
          scope: input.scope,
          selection: model("requested-A"),
          observation: input.observation,
          runId: input.runId,
        },
      }),
    ).toEqual(model("requested-A"));
  });
  it("keeps that choice while the old turn finishes or the new turn has not reported", () => {
    const pending = {
      scope: input.scope,
      selection: model("next-C"),
      observation: input.observation,
      runId: input.runId,
    };
    expect(
      resolveLiveComposerModel({ ...input, pending, observation: "old-turn-completed" }),
    ).toEqual(model("next-C"));
    expect(
      resolveLiveComposerModel({
        ...input,
        pending,
        runId: "run-2",
        lastRequested: model("next-C"),
      }),
    ).toEqual(model("next-C"));
  });
  it("uses the next actual answer after the selected model's new run reports", () => {
    expect(
      resolveLiveComposerModel({
        ...input,
        configured: model("next-C"),
        draft: model("next-C"),
        lastRequested: model("next-C"),
        reported: model("answered-D"),
        observation: "answer-2",
        runId: "run-2",
        pending: {
          scope: input.scope,
          selection: model("next-C"),
          observation: "answer-1",
          runId: "run-1",
        },
      }),
    ).toEqual(model("answered-D"));
  });
  it("never imports another thread's pending choice or another account's report", () => {
    expect(
      resolveLiveComposerModel({
        ...input,
        pending: {
          scope: "mac:other-thread",
          selection: model("foreign"),
          observation: input.observation,
          runId: input.runId,
        },
      }),
    ).toEqual(model("answered-B"));
    expect(
      resolveLiveComposerModel({ ...input, reported: model("foreign", "other-account") }),
    ).toEqual(input.configured);
  });
  it("preserves a deliberate persisted model change from another client", () => {
    expect(resolveLiveComposerModel({ ...input, configured: model("next-C") })).toEqual(
      model("next-C"),
    );
  });
  it("keeps the actual thread selection when observation is absent, never a global default", () => {
    expect(resolveLiveComposerModel({ ...input, reported: null })).toEqual(input.configured);
  });
});

describe("live composer observation attribution", () => {
  const provider = {
    id: ProviderThreadId.make("active"),
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: v2Projection.thread.providerInstanceId,
    providerSessionId: ProviderSessionId.make("session"),
    appThreadId: v2Projection.thread.id,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "idle" as const,
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: v2Now,
    updatedAt: v2Now,
    nativeMetadata: {
      modelSelection: { ...v2Projection.thread.modelSelection, model: "observed" },
    },
  };
  const projection = {
    ...v2Projection,
    thread: { ...v2Projection.thread, activeProviderThreadId: provider.id },
    providerThreads: [provider],
  };
  const run = (
    id: string,
    ordinal: number,
    providerThreadId = provider.id,
  ): OrchestrationV2Run => ({
    id: RunId.make(id),
    ordinal,
    threadId: projection.thread.id,
    providerInstanceId: projection.thread.providerInstanceId,
    modelSelection: { ...projection.thread.modelSelection, model: id },
    providerThreadId,
    userMessageId: MessageId.make(`message-${id}`),
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    requestedAt: v2Now,
    startedAt: v2Now,
    completedAt: v2Now,
    checkpointId: null,
    contextHandoffId: null,
  });
  it("ignores another native provider thread on the same account after a handoff", () => {
    expect(
      readLiveComposerObservation({
        ...projection,
        runs: [run("current", 1), run("foreign", 2, ProviderThreadId.make("previous"))],
      }).runId,
    ).toBe("current");
  });
  it("does not change observation freshness when completed runs are reordered", () => {
    const old = run("old", 1),
      latest = run("latest", 2);
    expect(readLiveComposerObservation({ ...projection, runs: [old, latest] })).toEqual(
      readLiveComposerObservation({ ...projection, runs: [latest, old] }),
    );
  });
  it("does not treat another account's metadata as an active observation marker", () => {
    const foreign = { ...provider, providerInstanceId: ProviderInstanceId.make("foreign") };
    const before = readLiveComposerObservation({ ...projection, providerThreads: [foreign] });
    expect(before.reported).toBeNull();
    expect(before.observation).toBe(
      readLiveComposerObservation({ ...projection, providerThreads: [] }).observation,
    );
  });
  it("keeps a new choice when an older run completes but the new run has not reported", () => {
    const old = { ...run("old", 1), status: "running" as const, completedAt: null };
    const before = readLiveComposerObservation({ ...projection, runs: [old] });
    const next = {
      ...run("next", 2),
      status: "starting" as const,
      completedAt: null,
      modelSelection: { ...projection.thread.modelSelection, model: "new-choice" },
    };
    const after = readLiveComposerObservation({ ...projection, runs: [run("old", 1), next] });
    const choice = next.modelSelection;
    expect(
      resolveLiveComposerModel({
        scope: "handoff",
        configured: choice,
        ...after,
        pending: {
          scope: "handoff",
          selection: choice,
          observation: before.observation,
          runId: before.runId,
        },
      }),
    ).toEqual(choice);
  });
});
