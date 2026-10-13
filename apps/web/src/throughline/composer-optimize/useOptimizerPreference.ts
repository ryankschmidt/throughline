import { useSyncExternalStore } from "react";
import type { OptimizationProvider } from "./draftOptimization";
import {
  OPTIMIZER_PREFERENCE_KEY,
  readOptimizerPreference,
  writeOptimizerPreference,
} from "./optimizerPreference";

const listeners = new Set<() => void>();
function storage() {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === OPTIMIZER_PREFERENCE_KEY || event.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}
function getSnapshot() {
  return readOptimizerPreference(storage());
}
export function saveOptimizerPreference(provider: OptimizationProvider) {
  const saved = writeOptimizerPreference(storage(), provider);
  if (saved) for (const listener of listeners) listener();
  return saved;
}
export function useOptimizerPreference() {
  return useSyncExternalStore(subscribe, getSnapshot, () => "claude" as const);
}
