import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { HighlighterCore, ThemedToken } from "@shikijs/core";

import type { NativeReviewDiffRow } from "./nativeReviewDiffSurface";
import type { NativeReviewDiffFile } from "./nativeReviewDiffTypes";
import { highlightNativeReviewDiffVisibleRows } from "./nativeReviewDiffHighlighter";

const tokenization = vi.hoisted(() => ({
  calls: [] as string[],
  afterCall: undefined as (() => void) | undefined,
  highlighters: [] as HighlighterCore[],
  compareLegacy: false,
  comparisons: [] as Array<{ actual: ThemedToken[][]; legacy: ThemedToken[][] }>,
}));

vi.mock("@shikijs/core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@shikijs/core")>();
  return {
    ...original,
    createHighlighterCore: async (...args: Parameters<typeof original.createHighlighterCore>) => {
      const highlighter = await original.createHighlighterCore(...args);
      tokenization.highlighters.push(highlighter);
      return highlighter;
    },
    tokenizeWithTheme: (...input: Parameters<typeof original.tokenizeWithTheme>) => {
      tokenization.calls.push(input[0]);
      const result = original.tokenizeWithTheme(...input);
      if (tokenization.compareLegacy) {
        const registryGrammar: (typeof input)[1] = Object.getPrototypeOf(input[1]);
        const highlighter = tokenization.highlighters.find((candidate) =>
          candidate
            .getLoadedLanguages()
            .some((language) => candidate.getLanguage(language) === registryGrammar),
        );
        if (!highlighter) throw new Error("Missing real highlighter for token parity control");
        tokenization.comparisons.push({
          actual: result,
          legacy: highlighter.codeToTokensBase(input[0], {
            ...input[4],
            lang: registryGrammar.name,
            theme: input[2].name,
          }),
        });
      }
      tokenization.afterCall?.();
      return result;
    },
  };
});

// Exercise the native entry path without requiring an iOS or Android runtime.
vi.mock("react-native-shiki-engine", async () => {
  const { createJavaScriptRegexEngine } = await import("@shikijs/engine-javascript");
  return { isNativeEngineAvailable: () => true, createNativeEngine: createJavaScriptRegexEngine };
});

afterEach(() => {
  tokenization.calls = [];
  tokenization.afterCall = undefined;
  tokenization.compareLegacy = false;
  tokenization.comparisons = [];
});

const TYPESCRIPT_FILE: NativeReviewDiffFile = {
  id: "file-1",
  path: "example.ts",
  language: "typescript",
  additions: 0,
  deletions: 0,
};

function makeLine(
  input: Pick<NativeReviewDiffRow, "id" | "content" | "change" | "oldLineNumber" | "newLineNumber">,
): NativeReviewDiffRow {
  return {
    kind: "line",
    fileId: TYPESCRIPT_FILE.id,
    ...input,
  };
}

function makeHunk(id: string): NativeReviewDiffRow {
  return {
    kind: "hunk",
    id,
    fileId: TYPESCRIPT_FILE.id,
    text: "@@",
  };
}

function highlight(
  rows: ReadonlyArray<NativeReviewDiffRow>,
  alreadyHighlightedRowIds?: ReadonlySet<string>,
) {
  return highlightNativeReviewDiffVisibleRows({
    rows,
    files: [TYPESCRIPT_FILE],
    scheme: "dark",
    engine: "javascript",
    firstRowIndex: 0,
    lastRowIndex: rows.length - 1,
    overscanRows: 0,
    maxRows: 100,
    alreadyHighlightedRowIds,
  });
}

describe("highlightNativeReviewDiffVisibleRows", () => {
  it("does not carry grammar state across hunk boundaries", async () => {
    const exportRow = makeLine({
      id: "export-row",
      content: "export async function run() {}",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 100,
    });
    const rows = [
      makeHunk("hunk-1"),
      makeLine({
        id: "import-open",
        content: "import {",
        change: "context",
        oldLineNumber: 1,
        newLineNumber: 1,
      }),
      makeLine({
        id: "import-entry",
        content: "  Model,",
        change: "context",
        oldLineNumber: 2,
        newLineNumber: 2,
      }),
      makeHunk("hunk-2"),
      exportRow,
    ];

    const [highlighted, standalone] = await Promise.all([
      highlight(rows),
      highlight([makeHunk("standalone-hunk"), exportRow]),
    ]);

    expect(highlighted.tokensByRowId[exportRow.id]).toEqual(standalone.tokensByRowId[exportRow.id]);
  });

  it("keeps grammar state across inline comment rows", async () => {
    const openingRow = makeLine({
      id: "template-open",
      content: "const message = `open",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 1,
    });
    const closingRow = makeLine({
      id: "template-close",
      content: "closed`;",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 2,
    });
    const trailingRow = makeLine({
      id: "trailing-row",
      content: "export const answer = 42;",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 3,
    });
    const commentRow: NativeReviewDiffRow = {
      kind: "comment",
      id: "comment-1",
      fileId: TYPESCRIPT_FILE.id,
      commentText: "Review note",
    };

    const [withComment, contiguous] = await Promise.all([
      highlight([openingRow, commentRow, closingRow, trailingRow]),
      highlight([openingRow, closingRow, trailingRow]),
    ]);

    expect(withComment.tokensByRowId).toEqual(contiguous.tokensByRowId);
  });

  it("refuses incomplete grammar tokens when the unchanged tokenization budget expires", async () => {
    const rows = [
      makeLine({
        id: "budget-open",
        content: "const message = `open",
        change: "add",
        oldLineNumber: null,
        newLineNumber: 1,
      }),
      makeLine({
        id: "budget-close",
        content: "closed`;",
        change: "add",
        oldLineNumber: null,
        newLineNumber: 2,
      }),
    ];
    // Finish engine/grammar initialization before controlling TextMate's clock.
    await highlight(rows);
    let elapsed = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => (elapsed += 600));
    try {
      await expect(highlight(rows)).rejects.toThrow(/tokenization.*incomplete/i);
    } finally {
      clock.mockRestore();
    }
  });

  it("preserves the original public token arrays and grammar threading across chunks", async () => {
    const contents = ["const message = `open", ...Array(10).fill("x".repeat(900)), "closed`;"];
    const rows = contents.map((content, index) =>
      makeLine({
        id: `parity-${index}`,
        content,
        change: "add",
        oldLineNumber: null,
        newLineNumber: index + 1,
      }),
    );
    tokenization.compareLegacy = true;
    const result = await highlight(rows);
    expect(Object.keys(result.tokensByRowId)).toHaveLength(rows.length);
    expect(tokenization.comparisons.length).toBeGreaterThan(1);
    for (const comparison of tokenization.comparisons) {
      expect(comparison.actual).toEqual(comparison.legacy);
    }
  });

  it("does not join unhighlighted rows across cached gaps", async () => {
    const trailingRow = makeLine({
      id: "trailing-row",
      content: "export const answer = 42;",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 3,
    });
    const rows = [
      makeLine({
        id: "template-open",
        content: "const message = `open",
        change: "add",
        oldLineNumber: null,
        newLineNumber: 1,
      }),
      makeLine({
        id: "template-close",
        content: "closed`;",
        change: "add",
        oldLineNumber: null,
        newLineNumber: 2,
      }),
      trailingRow,
    ];

    const [highlighted, standalone] = await Promise.all([
      highlight(rows, new Set(["template-close"])),
      highlight([trailingRow]),
    ]);

    expect(highlighted.tokensByRowId[trailingRow.id]).toEqual(
      standalone.tokensByRowId[trailingRow.id],
    );
  });

  it("keeps deletion grammar state out of addition rows", async () => {
    const additionRow = makeLine({
      id: "addition-row",
      content: "export const answer = 42;",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 1,
    });
    const rows = [
      makeLine({
        id: "deletion-row",
        content: "const removed = `open",
        change: "delete",
        oldLineNumber: 1,
        newLineNumber: null,
      }),
      additionRow,
    ];

    const [highlighted, standalone] = await Promise.all([
      highlight(rows),
      highlight([additionRow]),
    ]);

    expect(highlighted.tokensByRowId[additionRow.id]).toEqual(
      standalone.tokensByRowId[additionRow.id],
    );
  });
});

describe.each(["native", "javascript"] as const)("%s highlighting budgets", (engine) => {
  const highlightRows = (rows: ReadonlyArray<NativeReviewDiffRow>, signal?: AbortSignal) =>
    highlightNativeReviewDiffVisibleRows({
      rows,
      files: [TYPESCRIPT_FILE],
      scheme: "dark",
      engine,
      firstRowIndex: 0,
      lastRowIndex: rows.length - 1,
      overscanRows: 0,
      signal,
    });

  const line = (id: number, content: string) =>
    makeLine({
      id: `line-${id}`,
      content,
      change: "add",
      oldLineNumber: null,
      newLineNumber: id,
    });

  it("still highlights a line at the length limit", async () => {
    const content = `// ${"x".repeat(997)}`;
    const result = await highlightRows([line(1, content)]);

    expect(tokenization.calls).toEqual([content]);
    expect(result.tokensByRowId["line-1"]?.some((token) => token.color !== null)).toBe(true);
  });

  it("keeps only the long line plain and resumes highlighting after it", async () => {
    const longLine = `${"x".repeat(1_001)} /*`;
    const rows = [
      line(1, "export const before = 1;"),
      line(2, longLine),
      { kind: "comment", id: "note", commentText: "Check this", fileId: TYPESCRIPT_FILE.id },
      line(3, "export const inside = 'x';"),
      makeHunk("next-hunk"),
      line(100, "export const after = 2;"),
    ] satisfies ReadonlyArray<NativeReviewDiffRow>;
    const result = await highlightRows(rows);

    expect(result.engine).toBe(engine);
    expect(Object.keys(result.tokensByRowId)).toEqual(["line-1", "line-2", "line-3", "line-100"]);
    expect(result.tokensByRowId["line-2"]).toEqual([
      { content: longLine, color: null, fontStyle: null },
    ]);
    for (const id of ["line-1", "line-3", "line-100"]) {
      expect(result.tokensByRowId[id]?.some((token) => token.color !== null)).toBe(true);
    }
    expect(tokenization.calls.some((code) => code.includes(longLine))).toBe(false);
  });

  it("highlights the rows after a long line the same regardless of the first window", async () => {
    const rows = [
      line(1, "export const before = 1;"),
      line(2, `const data = "${"x".repeat(1_050)}";`),
      line(3, "export const inside = 'x';"),
      line(4, "export const after = 2;"),
    ];
    const spanning = await highlightRows(rows);
    const afterLongLine = await highlightNativeReviewDiffVisibleRows({
      rows,
      files: [TYPESCRIPT_FILE],
      scheme: "dark",
      engine,
      firstRowIndex: 2,
      lastRowIndex: 3,
      overscanRows: 0,
    });

    for (const id of ["line-3", "line-4"]) {
      expect(spanning.tokensByRowId[id]?.some((token) => token.color !== null)).toBe(true);
      expect(afterLongLine.tokensByRowId[id]).toEqual(spanning.tokensByRowId[id]);
    }
  });

  it("preserves multiline grammar and row mapping across character-limited batches", async () => {
    const opening = line(1, "const message = `open");
    const body = Array.from({ length: 40 }, (_, index) => line(index + 2, "inside ".repeat(45)));
    const closing = line(42, "closed`; ");
    const trailing = line(43, "export const after = 2;");
    const result = await highlightRows([opening, ...body, closing, trailing]);
    const calls = [...tokenization.calls];
    const expected = await highlightRows([
      opening,
      { ...closing, newLineNumber: 2 },
      { ...trailing, newLineNumber: 3 },
    ]);

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((code) => code.length <= 8_000)).toBe(true);
    expect(result.rowCount).toBe(43);
    for (const row of [opening, ...body, closing, trailing]) {
      expect(result.tokensByRowId[row.id]?.map((token) => token.content).join("")).toBe(
        row.content,
      );
    }
    expect(result.tokensByRowId[closing.id]).toEqual(expected.tokensByRowId[closing.id]);
    expect(result.tokensByRowId[trailing.id]).toEqual(expected.tokensByRowId[trailing.id]);
  });

  it("stops before later batches and publishes no partial result after cancellation", async () => {
    const controller = new AbortController();
    tokenization.afterCall = () => controller.abort();
    const rows = Array.from({ length: 30 }, (_, index) => line(index + 1, `// ${"x".repeat(400)}`));

    const result = await highlightRows(rows, controller.signal);

    expect(tokenization.calls).toHaveLength(1);
    expect(result.rowCount).toBe(0);
    expect(result.tokensByRowId).toEqual({});
  });
});
