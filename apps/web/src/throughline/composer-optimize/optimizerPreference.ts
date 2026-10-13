import type { OptimizationProvider } from "./draftOptimization";

export const OPTIMIZER_PREFERENCE_KEY = "throughline:voice-optimization-provider";
export const OPTIMIZER_PROVIDER_OPTIONS = [
  { value: "claude", label: "Claude (default)" },
  { value: "codex", label: "Codex" },
  { value: "off", label: "Off" },
] as const;
export type OptimizerPreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export function readOptimizerPreference(
  storage: OptimizerPreferenceStorage | null,
): OptimizationProvider {
  try {
    const value = storage?.getItem(OPTIMIZER_PREFERENCE_KEY);
    return value === "claude" || value === "codex" || value === "off" ? value : "claude";
  } catch {
    return "claude";
  }
}

export function writeOptimizerPreference(
  storage: OptimizerPreferenceStorage | null,
  provider: OptimizationProvider,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(OPTIMIZER_PREFERENCE_KEY, provider);
    return true;
  } catch {
    return false;
  }
}
