// Retains the 0.0.60 policy/default behavior; stock schemas stay upstream-owned.
import policy from "./model-policy.json" with { type: "json" };
import { ProviderDriverKind } from "../providerInstance.ts";
import { MUSE_DEFAULT_MODEL, ANTIGRAVITY_DEFAULT_MODEL } from "../model.ts";

const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");

const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");

const CURSOR_DRIVER_KIND = ProviderDriverKind.make("cursor");

const GROK_DRIVER_KIND = ProviderDriverKind.make("grok");

const MUSE_DRIVER_KIND = ProviderDriverKind.make("muse");

const PI_DRIVER_KIND = ProviderDriverKind.make("pi");

const ACP_REGISTRY_DRIVER_KIND = ProviderDriverKind.make("acpRegistry");

const OPENCODE_DRIVER_KIND = ProviderDriverKind.make("opencode");

export const DEFAULT_MODEL = policy.DEFAULT_MODEL;

export function isCurrentCodexModel(model: string): boolean {
  return model === "gpt-5.3-codex-spark" || /^gpt-(?:5\.6|6)(?:$|[.-])/.test(model);
}

export function isAllowedProviderModel(model: string, driver: string): boolean {
  const parts = model.split("/");
  const modelId = parts.at(-1) ?? model;
  const isOpenAi =
    driver === "codex" ||
    parts.some((part) => part === "openai" || part === "openai-codex") ||
    /^(?:gpt-|codex-|o\d(?:-|$))/.test(modelId);
  return !isOpenAi || isCurrentCodexModel(modelId);
}

export const CATALOGUE_SOURCE_DRIVER_KINDS: ReadonlyArray<string> =
  policy.CATALOGUE_SOURCE_DRIVER_KINDS;

export const CATALOGUE_MIRROR_DRIVER_KINDS: ReadonlyArray<string> =
  policy.CATALOGUE_MIRROR_DRIVER_KINDS;

export function modelIdentity(model: string): string {
  const parts = model.split("/");
  return (parts.at(-1) ?? model).trim().toLowerCase();
}

export function isCatalogueSourceDriver(driver: string): boolean {
  return CATALOGUE_SOURCE_DRIVER_KINDS.includes(driver);
}

export function isCatalogueMirrorDriver(driver: string): boolean {
  return CATALOGUE_MIRROR_DRIVER_KINDS.includes(driver);
}

export type CatalogueProviderLike = {
  readonly driver: string;
  readonly models: ReadonlyArray<{ readonly slug: string; readonly isCustom?: boolean }>;
};

export function buildCatalogueParity(
  providers: ReadonlyArray<CatalogueProviderLike>,
): ReadonlySet<string> {
  const parity = new Set<string>();
  for (const provider of providers) {
    if (!isCatalogueSourceDriver(provider.driver)) continue;
    for (const model of provider.models) {
      if (model.isCustom === true) continue;
      if (!isAllowedProviderModel(model.slug, provider.driver)) continue;
      parity.add(modelIdentity(model.slug));
    }
  }
  return parity;
}

export function isOfferedProviderModel(
  model: string,
  driver: string,
  context?: {
    readonly parity?: ReadonlySet<string> | undefined;
    readonly isCustom?: boolean | undefined;
  },
): boolean {
  // The allowlist applies to authored models too: a retired model stays
  // retired however it was entered. Only parity is waived for custom slugs.
  if (!isAllowedProviderModel(model, driver)) return false;
  if (context?.isCustom === true) return true;
  if (!isCatalogueMirrorDriver(driver)) return true;

  // A mirror driver with nothing to mirror offers NOTHING, and the order of these two lines is
  // the whole fix. This used to return true when parity was empty or absent, so on a cold start
  // — before either source provider had reported — Pi fell back to its own unfiltered catalogue
  // and the picker showed all 331 models it proxies, then shrank a moment later once Claude and
  // Codex reported. Ryan photographed exactly that screen. His ruling is "the same models as
  // Claude provider and Codex provider and nothing more, nothing more", and a list that briefly
  // shows 331 shows 331.
  //
  // An empty list that fills in is correct. A full list that shrinks is the defect. Absent
  // parity is treated the same as empty parity on purpose: a caller that cannot compute parity
  // does not know what the mirror may offer, and "unknown" must not render as "everything".
  const parity = context?.parity;
  if (parity === undefined || parity.size === 0) return false;
  return parity.has(modelIdentity(model));
}

export type ModelAnswerVerdict = "match" | "mismatch" | "unknown";

export function normalizeModelIdentityForComparison(model: string): string {
  return modelIdentity(model)
    .replace(/\[\d+[km]\]$/, "")
    .replace(/-\d{8}$/, "")
    .trim();
}

export function compareSelectedAndAnsweringModel(
  selected: string | null | undefined,
  answering: string | null | undefined,
): ModelAnswerVerdict {
  const selectedId = selected ? normalizeModelIdentityForComparison(selected) : "";
  const answeringId = answering ? normalizeModelIdentityForComparison(answering) : "";
  if (selectedId.length === 0 || answeringId.length === 0) return "unknown";
  // Version, fast-mode, and moving-alias suffixes may name different models.
  // Only the explicitly normalized route/date/window decoration is equivalent.
  return selectedId === answeringId ? "match" : "mismatch";
}

export const PREFERRED_DEFAULT_CODEX_MODELS: ReadonlyArray<string> =
  policy.PREFERRED_DEFAULT_CODEX_MODELS;

export const DEFAULT_MODEL_BY_PROVIDER: Partial<Record<ProviderDriverKind, string>> =
  policy.DEFAULT_MODEL_BY_PROVIDER;

export function isProductDefaultModel(
  model: string,
  driver: string,
  providerReportedDefault: boolean,
): boolean {
  const declared = (DEFAULT_MODEL_BY_PROVIDER as Record<string, string | undefined>)[driver];
  if (declared === undefined) return providerReportedDefault;
  return modelIdentity(model) === modelIdentity(declared);
}

export const DEFAULT_REASONING_EFFORT_BY_PROVIDER: Partial<Record<string, string>> =
  policy.DEFAULT_REASONING_EFFORT_BY_PROVIDER;

export function defaultReasoningEffortForDriver(driver: string): string | undefined {
  return DEFAULT_REASONING_EFFORT_BY_PROVIDER[driver];
}

export const MODEL_SLUG_ALIASES_BY_PROVIDER: Partial<
  Record<ProviderDriverKind, Record<string, string>>
> = policy.MODEL_SLUG_ALIASES_BY_PROVIDER;
