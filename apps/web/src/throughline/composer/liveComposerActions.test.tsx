import { afterEach, describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import { Effect, FileSystem } from "effect";
import { isValidElement, type ComponentProps } from "react";
import {
  EnvironmentId,
  ThreadId,
  ProviderInstanceId,
  ProviderDriverKind,
  type ModelSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createModelSelection } from "@t3tools/shared/model";
import { composerTargetKey, useComposerDraftStore } from "../../composerDraftStore";
import { TraitsPicker } from "../../components/chat/TraitsPicker";
import { renderProviderTraitsPicker } from "../../components/chat/composerProviderState";
import { resolveLiveComposerModel, resolveChatComposerDispatchModel } from "./ComposerCarry";
import {
  bindPendingComposerRequest,
  persistLiveComposerOptions,
  withLiveTraitsPersistence,
} from "./liveComposerActions";
import { readFiniteRestingTraitsMount } from "./finiteDispatchSource.testkit";

const target = scopeThreadRef(
  EnvironmentId.make("source-fixture"),
  ThreadId.make("source-actions"),
);
const scope = composerTargetKey(target);
const account = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const A = createModelSelection(account, "gpt-5.4", [{ id: "reasoningEffort", value: "medium" }]);
const B = createModelSelection(account, "gpt-5.3-codex", [
  { id: "reasoningEffort", value: "high" },
]);
const options = [{ id: "reasoningEffort", value: "xhigh" }] as const;
const read = () =>
  useComposerDraftStore.getState().draftsByThreadKey[scope]?.modelSelectionByProvider[account];
const seed = (selection: ModelSelection) =>
  useComposerDraftStore
    .getState()
    .setModelSelection(target, selection, { explicit: true, replaceOptions: true });
const applyOptions = (next: ModelSelection["options"]) =>
  useComposerDraftStore.getState().setProviderModelOptions(target, driver, next, {
    instanceId: account,
    model: B.model,
    persistSticky: true,
  });
afterEach(() => useComposerDraftStore.getState().clearDraftThread(target));

describe("real picker/send and public option persistence sequences", () => {
  it("qualifies the actual public store and stock callback defect before the fork correction", () => {
    seed(A);
    applyOptions(options);
    expect(read()).toEqual(createModelSelection(account, A.model, options));
  });
  it("consumes the actual model-only picker choice after its option-bearing dispatch and new report", () => {
    seed(A);
    const picked = { instanceId: account, model: "gpt-6.1-sol" };
    useComposerDraftStore.getState().setModelSelection(target, picked, { explicit: true });
    const pending = { scope, selection: picked, observation: "before", runId: "old" };
    const live = resolveLiveComposerModel({
      scope,
      configured: A,
      reported: B,
      lastRequested: A,
      draft: read() ?? null,
      pending,
      observation: "before",
      runId: "old",
    });
    const request = resolveChatComposerDispatchModel(live, B, read()?.options);
    expect(request.options).toEqual(A.options);
    const bound = bindPendingComposerRequest(pending, scope, request);
    expect(
      resolveLiveComposerModel({
        scope,
        configured: request,
        draft: request,
        lastRequested: request,
        reported: B,
        pending: bound,
        observation: "after",
        runId: "new",
      }),
    ).toEqual(B);
  });
  it("routes an actual public traits callback to B with the new options, not the stored A", () => {
    seed(A);
    const models: ReadonlyArray<ServerProviderModel> = [
      {
        slug: B.model,
        name: B.model,
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning effort",
              type: "select",
              options: [
                { id: "high", label: "High" },
                { id: "xhigh", label: "Extra High" },
              ],
            },
          ],
        },
      },
    ];
    const stock = renderProviderTraitsPicker({
      provider: driver,
      instanceId: account,
      threadRef: target,
      model: B.model,
      models,
      modelOptions: B.options,
      reportedModelSelection: B,
      prompt: "",
      onPromptChange: () => {},
      planModeEnabled: false,
    });
    expect(isValidElement(stock)).toBe(true);
    const control = withLiveTraitsPersistence(stock, (next) => {
      persistLiveComposerOptions(B, next, { seed, applyOptions, read });
    });
    if (
      !isValidElement<ComponentProps<typeof TraitsPicker>>(control) ||
      !("onModelOptionsChange" in control.props) ||
      typeof control.props.onModelOptionsChange !== "function"
    )
      throw new Error("Actual public traits callback missing");
    control.props.onModelOptionsChange(options);
    expect(read()).toEqual(createModelSelection(account, B.model, options));
  });
  it("keeps the original observation/run markers and refuses a foreign scope or newer option choice", () => {
    const raw = {
      scope,
      selection: { instanceId: account, model: B.model },
      observation: "original",
      runId: "original-run",
    };
    const bound = bindPendingComposerRequest(raw, scope, B);
    expect(bound).toEqual({ ...raw, selection: B });
    expect(raw.selection).toEqual({ instanceId: account, model: B.model });
    expect(bindPendingComposerRequest(raw, "foreign", B)).toBe(raw);
    const newer = { ...raw, selection: createModelSelection(account, B.model, options) };
    expect(bindPendingComposerRequest(newer, scope, B)).toBe(newer);
  });
  it("clears options on displayed B without restoring A or old native options", () => {
    seed(A);
    const result = persistLiveComposerOptions(B, undefined, { seed, applyOptions, read });
    expect(result).toEqual(createModelSelection(account, B.model));
    expect(read()).toEqual(createModelSelection(account, B.model));
  });
  it("does not restore old options when the post-write snapshot is unavailable", () => {
    seed(A);
    expect(
      persistLiveComposerOptions(B, options, { seed, applyOptions, read: () => undefined }),
    ).toEqual(createModelSelection(account, B.model, options));
  });
});

// Source-only interpretation of the actual resting initializer AND JSX use.
// The actual public renderer/store execute; this is not a mounted UI test.
describe("actual resting traits source and public persistence sequence", () => {
  const models: ReadonlyArray<ServerProviderModel> = [
    {
      slug: B.model,
      name: B.model,
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning effort",
            type: "select",
            options: [
              { id: "high", label: "High" },
              { id: "xhigh", label: "Extra High" },
            ],
          },
        ],
      },
    },
  ];
  const loadMount = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const source = yield* fs.readFileString(
      NodeURL.fileURLToPath(new URL("../../components/chat/ChatComposer.tsx", import.meta.url)),
    );
    return readFiniteRestingTraitsMount(source);
  });
  function consume(
    mount: { wrapped: boolean },
    collapsed: boolean,
    controlsHidden: boolean,
    hiddenBlocks: number,
    catalog = models,
    displayed = B,
  ) {
    const rendered = renderProviderTraitsPicker({
      provider: driver,
      instanceId: account,
      threadRef: target,
      model: displayed.model,
      models: catalog,
      modelOptions: displayed.options,
      reportedModelSelection: displayed,
      prompt: "",
      onPromptChange: () => {},
      planModeEnabled: false,
      isComposerOwned: true,
      size: collapsed ? "xs" : "sm",
      hidden: controlsHidden || hiddenBlocks > 1,
    });
    return mount.wrapped
      ? withLiveTraitsPersistence(rendered, (next) => {
          persistLiveComposerOptions(displayed, next, { seed, applyOptions, read });
        })
      : rendered;
  }
  function change(control: ReturnType<typeof consume>, next: ModelSelection["options"]) {
    if (!isValidElement<ComponentProps<typeof TraitsPicker>>(control))
      throw new Error("Stock resting control missing");
    const props = control.props;
    if ("onModelOptionsChange" in props) {
      props.onModelOptionsChange(next);
    } else {
      // Stock public thread/draft persistence branch, qualified separately by
      // the existing stored-A control. No mock store or fake callback.
      const destination = props.threadRef ?? props.draftId;
      if (!destination) throw new Error("Stock persistence destination missing");
      useComposerDraftStore.getState().setProviderModelOptions(destination, props.provider, next, {
        ...(props.instanceId ? { instanceId: props.instanceId } : {}),
        model: props.model,
        persistSticky: true,
      });
    }
  }
  for (const [name, next, displayed] of [
    ["effort", options, B],
    ["clear", undefined, B],
    ["omitted native options", options, createModelSelection(account, B.model)],
  ] as const) {
    effectIt.effect(`preserves displayed B in the actual rendered resting ${name} path`, () =>
      Effect.gen(function* () {
        const mount = yield* loadMount;
        seed(A);
        change(consume(mount, true, false, 0, models, displayed), next);
        expect(read()).toEqual(createModelSelection(account, B.model, next));
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  }
  effectIt.effect("retains actual resting size/hidden inputs and stock catalog/null guards", () =>
    Effect.gen(function* () {
      const mount = yield* loadMount;
      for (const [collapsed, hidden, blocks] of [
        [true, false, 0],
        [false, false, 0],
        [true, true, 0],
        [false, false, 2],
      ] as const) {
        const control = consume(mount, collapsed, hidden, blocks);
        if (!isValidElement<ComponentProps<typeof TraitsPicker>>(control))
          throw new Error("Stock control missing");
        expect(control.type).toBe(TraitsPicker);
        expect(control.props.size).toBe(collapsed ? "xs" : "sm");
        expect(control.props.hidden).toBe(hidden || blocks > 1);
        expect(control.props.isComposerOwned).toBe(true);
      }
      expect(consume(mount, true, false, 0, [])).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
