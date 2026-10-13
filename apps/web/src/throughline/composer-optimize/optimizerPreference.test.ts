import { describe, expect, it } from "vite-plus/test";
import {
  OPTIMIZER_PREFERENCE_KEY,
  OPTIMIZER_PROVIDER_OPTIONS,
  readOptimizerPreference,
  writeOptimizerPreference,
  type OptimizerPreferenceStorage,
} from "./optimizerPreference";

function storage(): OptimizerPreferenceStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe("desktop optimizer preference matches phone settings", () => {
  it("uses the same Claude default, Codex and Off options", () => {
    expect(OPTIMIZER_PROVIDER_OPTIONS).toEqual([
      { value: "claude", label: "Claude (default)" },
      { value: "codex", label: "Codex" },
      { value: "off", label: "Off" },
    ]);
    expect(readOptimizerPreference(storage())).toBe("claude");
  });
  it.each(["claude", "codex", "off"] as const)(
    "persists %s for a cold composer/settings read",
    (provider) => {
      const saved = storage();
      expect(writeOptimizerPreference(saved, provider)).toBe(true);
      expect(readOptimizerPreference(saved)).toBe(provider);
    },
  );
  it("does not reinterpret an invalid saved value as a provider", () => {
    const saved = storage();
    saved.setItem(OPTIMIZER_PREFERENCE_KEY, "foreign");
    expect(readOptimizerPreference(saved)).toBe("claude");
  });
  it("keeps the selected preference when saving fails and reports no success", () => {
    const saved = storage();
    saved.setItem(OPTIMIZER_PREFERENCE_KEY, "codex");
    expect(
      writeOptimizerPreference(
        {
          ...saved,
          setItem: () => {
            throw new Error("disk denied");
          },
        },
        "off",
      ),
    ).toBe(false);
    expect(readOptimizerPreference(saved)).toBe("codex");
    expect(writeOptimizerPreference(null, "off")).toBe(false);
    expect(readOptimizerPreference(null)).toBe("claude");
  });
});
