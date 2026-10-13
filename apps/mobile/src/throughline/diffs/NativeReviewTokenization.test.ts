import { createHighlighterCore, type GrammarState, type HighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import typescriptLanguage from "@shikijs/langs/typescript";
import { afterAll, beforeAll, expect, it, vi } from "vite-plus/test";

import { highlightNativeReviewDiffVisibleRows } from "../../features/diffs/nativeReviewDiffHighlighter";

vi.mock("react-native-shiki-engine", async () => {
  const { createJavaScriptRegexEngine } = await import("@shikijs/engine-javascript");
  return { isNativeEngineAvailable: () => true, createNativeEngine: createJavaScriptRegexEngine };
});

import { withCompletionGuard } from "./NativeReviewTokenization";

let original: HighlighterCore;
beforeAll(async () => {
  original = await createHighlighterCore({
    langs: [typescriptLanguage],
    themes: [{ name: "completion-control", type: "dark", settings: [] }],
    engine: createJavaScriptRegexEngine(),
  });
});
afterAll(() => original.dispose());

const options = { lang: "typescript", theme: "completion-control" };
const visibleInput = (contents: readonly string[]) => ({
  files: [
    {
      id: "file-1",
      path: "example.ts",
      language: "typescript" as const,
      additions: 0,
      deletions: 0,
    },
  ],
  rows: contents.map((content, index) => ({
    kind: "line" as const,
    fileId: "file-1",
    id: `line-${index}`,
    content,
    change: "add" as const,
    oldLineNumber: null,
    newLineNumber: index + 1,
  })),
  scheme: "dark" as const,
  engine: "javascript" as const,
  firstRowIndex: 0,
  lastRowIndex: contents.length - 1,
  overscanRows: 0,
  maxRows: 100,
});

it("refuses incomplete grammar tokens when the unchanged tokenization budget expires", async () => {
  const code = "const message = `open\nclosed`;";
  const guarded = withCompletionGuard(original);
  const grammar = original.getLanguage("typescript");
  const originalTokenizer = grammar.tokenizeLine2;
  await highlightNativeReviewDiffVisibleRows(visibleInput(code.split("\n")));
  let elapsed = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => (elapsed += 600));
  try {
    expect(() => guarded.codeToTokensBase(code, options)).toThrow(/tokenization.*incomplete/i);
    await expect(
      highlightNativeReviewDiffVisibleRows(visibleInput(code.split("\n"))),
    ).rejects.toThrow(/tokenization.*incomplete/i);
  } finally {
    clock.mockRestore();
  }
  expect(grammar.tokenizeLine2).toBe(originalTokenizer);
});

it("preserves the original public token arrays and grammar threading across chunks", async () => {
  const guarded = withCompletionGuard(original);
  const chunks = ["const message = `open", "x\n".repeat(10), "closed`;\nexport const answer = 42;"];
  let grammarState: GrammarState | undefined;
  for (const chunk of chunks) {
    const incoming = { ...options, grammarState };
    const actual = guarded.codeToTokensBase(chunk, incoming);
    const legacy = original.codeToTokensBase(chunk, incoming);
    expect(actual).toEqual(legacy);
    grammarState = original.getLastGrammarState(actual);
    expect(grammarState).toBeDefined();
  }
  const contents = [
    "const message = `open",
    ...Array<string>(10).fill("x".repeat(900)),
    "closed`;",
  ];
  const input = visibleInput(contents);
  const result = await highlightNativeReviewDiffVisibleRows(input);
  expect(Object.keys(result.tokensByRowId)).toHaveLength(contents.length);
  expect(result.tokensByRowId["line-11"]?.map((token) => token.content).join("")).toBe("closed`;");
});
