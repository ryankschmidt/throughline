import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import { Effect, FileSystem, Schema } from "effect";
import { ProviderInstanceId, ModelSelection } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Carry from "./ComposerCarry";
import { readFiniteDispatchCall } from "./finiteDispatchSource.testkit";

const decodeSelection = Schema.decodeUnknownSync(ModelSelection);

// Execute the real consumer initializer rather than a copied dispatch rule.
// This deliberately accepts only its small public call/identifier expression;
// an unexpected source form refuses instead of silently substituting a fixture.
function consumeDispatchInitializer(
  source: string,
  input: {
    liveModelSelection: ModelSelection;
    reported: ModelSelection | null;
    selectedInstanceId: ModelSelection["instanceId"];
    staleOptions: Parameters<typeof createModelSelection>[2];
  },
): ModelSelection {
  const call = readFiniteDispatchCall(source);
  const values = new Map<string, unknown>([
    ["liveModelSelection", input.liveModelSelection],
    ["liveObservation.reported", input.reported],
    ["selectedInstanceId", input.selectedInstanceId],
    ["selectedModel", input.liveModelSelection.model],
    ["selectedModelOptionsForDispatch", input.staleOptions],
  ]);
  const args = call.args.map((key) => {
    if (!values.has(key)) throw new Error(`Unqualified source argument: ${key}`);
    return values.get(key);
  });
  const name = call.callee;
  const fn: unknown =
    name === "createModelSelection" ? createModelSelection : Reflect.get(Carry, name);
  if (typeof fn !== "function") throw new Error(`Unqualified source adapter: ${name}`);
  const result: unknown = Reflect.apply(fn, undefined, args);
  return decodeSelection(result);
}

describe("real web composer next-dispatch identity", () => {
  const account = ProviderInstanceId.make("codex");
  const configured: ModelSelection = {
    instanceId: account,
    model: "same-model",
    options: [{ id: "reasoningEffort", value: "medium" }],
  };
  const reported: ModelSelection = {
    ...configured,
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  const staleOptions: Parameters<typeof createModelSelection>[2] = [
    { id: "reasoningEffort", value: "medium" },
  ];
  it("qualifies the fixture against the real public constructor before source consumption", () => {
    expect(createModelSelection(account, configured.model, staleOptions)).toEqual(configured);
    expect(createModelSelection(account, configured.model, [])).toEqual({
      instanceId: account,
      model: configured.model,
    });
  });
  function check(
    expected: ModelSelection,
    pending?: ModelSelection,
    actualReport: ModelSelection | null = reported,
  ) {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const source = yield* fs.readFileString(
        NodeURL.fileURLToPath(new URL("../../components/chat/ChatComposer.tsx", import.meta.url)),
      );
      const live = Carry.resolveLiveComposerModel({
        scope: "thread",
        configured,
        reported: actualReport,
        lastRequested: configured,
        observation: "report",
        runId: "run",
        ...(pending
          ? {
              pending: { scope: "thread", selection: pending, observation: "report", runId: "run" },
            }
          : {}),
      });
      expect(
        consumeDispatchInitializer(source, {
          liveModelSelection: live,
          reported: actualReport,
          selectedInstanceId: account,
          staleOptions,
        }),
      ).toEqual(expected);
      expect(source).toContain("getSendContext: () => ({");
      expect(source).toContain("selectedModelSelection,");
    }).pipe(Effect.provide(NodeServices.layer));
  }
  it.effect(
    "preserves native same-model/different-effort identity in the actual send-context source",
    () => check(reported),
  );
  it.effect("preserves an explicit same-model new-effort choice over the old native report", () => {
    const picked = { ...configured, options: [{ id: "reasoningEffort", value: "xhigh" }] };
    return check(picked, picked);
  });
  it.effect("does not insert stale default options into a native report that omitted options", () =>
    check({ instanceId: account, model: "same-model" }, undefined, {
      instanceId: account,
      model: "same-model",
    }),
  );
});
