import { codeToTokensBase, type HighlighterCore } from "@shikijs/core";
import * as Schema from "effect/Schema";

export class NativeReviewDiffTokenizationIncompleteError extends Schema.TaggedError<NativeReviewDiffTokenizationIncompleteError>()(
  "NativeReviewDiffTokenizationIncompleteError",
  { lang: Schema.String, lineLength: Schema.Number },
) {
  override get message(): string {
    return "Review diff tokenization is incomplete; interrupted grammar tokens cannot be cached.";
  }
}

/**
 * Owns one-call completion refusal, not chunking, review rows, theme policy or caches.
 * The public Shiki shell keeps plain/ANSI handling, theme refresh and grammar-state registration.
 */
export function withCompletionGuard(highlighter: HighlighterCore): HighlighterCore {
  type Grammar = ReturnType<HighlighterCore["getLanguage"]>;
  const grammars = new WeakMap<Grammar, Grammar>();
  const primitive: HighlighterCore = Object.create(highlighter);
  primitive.getLanguage = (language) => {
    const grammar = highlighter.getLanguage(language);
    const existing = grammars.get(grammar);
    if (existing) return existing;
    const watched: Grammar = Object.create(grammar);
    watched.tokenizeLine2 = (...args) => {
      const result = grammar.tokenizeLine2(...args);
      if (result.stoppedEarly) {
        throw new NativeReviewDiffTokenizationIncompleteError({
          lang: grammar.name,
          lineLength: args[0].length,
        });
      }
      return result;
    };
    grammars.set(grammar, watched);
    return watched;
  };
  const guarded: HighlighterCore = Object.assign(Object.create(highlighter), highlighter);
  guarded.codeToTokensBase = (code, options) => codeToTokensBase(primitive, code, options);
  return guarded;
}
