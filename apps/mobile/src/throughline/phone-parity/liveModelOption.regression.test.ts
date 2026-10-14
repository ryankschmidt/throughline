import type { ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ModelOption } from "../../lib/modelOptions";
import { withLiveModelOption } from "./liveModelOption";

const offered: ModelOption = {
  key: "claudeAgent:claude-opus-5-5",
  label: "Claude Opus 5.5",
  subtitle: "",
  providerKey: "claudeAgent",
  providerLabel: "ryan-claude",
  providerDriver: "claudeAgent",
  isDefault: true,
  isLegacy: false,
  capabilities: null,
  selection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
} as ModelOption;

const config = {
  providers: [{ instanceId: "claudeAgent", driver: "claudeAgent", models: [] }],
  settings: { providerInstances: {} },
} as unknown as ServerConfig;

describe("withLiveModelOption", () => {
  it("keeps a hidden or retired live model visible under its own provider, tagged unavailable", () => {
    const live = { instanceId: "claudeAgent", model: "claude-opus-5" } as ModelOption["selection"];
    const options = withLiveModelOption([offered], live, config);
    expect(options).toHaveLength(2);
    expect(options[1]).toMatchObject({
      label: "claude-opus-5",
      providerKey: "claudeAgent",
      providerLabel: "ryan-claude",
      providerDriver: "claudeAgent",
      isUnavailable: true,
      isDefault: false,
    });
    expect(options[1]?.selection).toBe(live);
  });

  it("leaves the catalog untouched when it already offers the live model", () => {
    const options = [offered];
    expect(withLiveModelOption(options, offered.selection, config)).toBe(options);
  });
});
