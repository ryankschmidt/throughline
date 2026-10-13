import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import { Effect, FileSystem } from "effect";
import {
  readFiniteDispatchCall,
  readFiniteRestingTraitsMount,
} from "./finiteDispatchSource.testkit";

const declaration =
  "const selectedModelSelection = useMemo<ModelSelection>(() => createModelSelection(selectedInstanceId, selectedModel, selectedModelOptionsForDispatch), [selectedInstanceId]);";
const binding =
  "getSendContext: () => ({ prompt, selectedModelSelection, other: { key }, multiple: array.map(x => x.model === selectedModelSelection.model) })";
const source = `${declaration}\nconst methods = { ${binding} };`;

describe("finite actual-source dispatch recognizer qualification", () => {
  it("accepts the exact positive initializer and send binding", () => {
    expect(readFiniteDispatchCall(source)).toEqual({
      callee: "createModelSelection",
      args: ["selectedInstanceId", "selectedModel", "selectedModelOptionsForDispatch"],
    });
  });
  it.each([
    ["missing", binding],
    ["duplicate", `${source}\n${declaration}`],
    [
      "unsupported",
      source.replace(
        "createModelSelection(selectedInstanceId",
        "createModelSelection({selectedInstanceId}",
      ),
    ],
    ["unknown argument", source.replace("selectedModel,", "foreignModel,")],
    ["unknown callee", source.replace("createModelSelection", "foreignCall")],
    ["comment decoy", `/* ${source} */`],
    [
      "line comment decoy",
      source
        .split("\n")
        .map((line) => `// ${line}`)
        .join("\n"),
    ],
    ["string decoy", `const decoy = ${JSON.stringify(source)};`],
    ["missing send binding", declaration],
    [
      "aliased send binding",
      source.replace("prompt, selectedModelSelection,", "prompt, selectedModelSelection: foreign,"),
    ],
    ["duplicate send binding", `${source}\nconst duplicate = {${binding}};`],
  ])("refuses %s", (_name, bad) => expect(() => readFiniteDispatchCall(bad)).toThrow());
  it.effect(
    "qualifies the actual frozen web initializer and exact send-context binding before behavioral cases",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const actual = yield* fs.readFileString(
          NodeURL.fileURLToPath(new URL("../../components/chat/ChatComposer.tsx", import.meta.url)),
        );
        expect(readFiniteDispatchCall(actual).args).toHaveLength(3);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const restingCall =
  'renderProviderTraitsPicker({ ...providerTraitsPickerInput, size: composerControlsCollapsed ? "xs" : "sm", hidden: composerControlsHidden || restingHiddenBlockCount > 1, })';
const restingUse = "const restingBlockDefs = [{ content: (<>{restingProviderTraitsPicker}</>) }];";
const restingSource = `const restingProviderTraitsPicker = ${restingCall}; ${restingUse}`;
describe("finite rendered resting traits source qualification", () => {
  it("distinguishes the real unwrapped and wrapped source mechanisms", () => {
    expect(readFiniteRestingTraitsMount(restingSource)).toEqual({ wrapped: false });
    expect(
      readFiniteRestingTraitsMount(
        restingSource.replace(
          restingCall,
          `withLiveTraitsPersistence(${restingCall}, changeLiveComposerOptions,)`,
        ),
      ),
    ).toEqual({ wrapped: true });
  });
  it.each([
    ["missing", restingUse],
    ["duplicate", `${restingSource} ${restingSource}`],
    ["foreign input", restingSource.replace("providerTraitsPickerInput", "foreignInput")],
    ["changed size", restingSource.replace('"xs"', '"lg"')],
    ["changed hidden guard", restingSource.replace("> 1", "> 0")],
    [
      "foreign callback",
      restingSource.replace(
        restingCall,
        `withLiveTraitsPersistence(${restingCall}, foreignCallback,)`,
      ),
    ],
    ["missing JSX use", restingSource.replace("{restingProviderTraitsPicker}", "{foreign}")],
    ["comment decoy", `/* ${restingSource} */`],
    ["string decoy", `const decoy = ${JSON.stringify(restingSource)};`],
  ])("refuses %s", (_name, bad) => expect(() => readFiniteRestingTraitsMount(bad)).toThrow());
});
