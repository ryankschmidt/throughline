import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import { Effect, FileSystem } from "effect";
import {
  resolveChatComposerLocalMenu,
  withLiveComposerPickerOption,
  liveComposerPickerDisabledReason,
} from "../../throughline/composer/ComposerCarry";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { resolveModelPickerSelectedModel } from "./ModelPickerContent";

describe("rejected Answered visual removal", () => {
  it.effect("removes the adornment from the real web and mobile mounts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const [web, mobile] = yield* Effect.all([
        fs.readFileString(NodeURL.fileURLToPath(new URL("./ChatComposer.tsx", import.meta.url))),
        fs.readFileString(
          NodeURL.fileURLToPath(
            new URL("../../../../mobile/src/features/threads/ThreadComposer.tsx", import.meta.url),
          ),
        ),
      ]);
      expect(web).not.toContain("ChatComposerAnsweringModelNotice");
      expect(mobile).not.toContain("answeringModelLabel");
      expect(web).toContain("resolveLiveComposerModel");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("live picker catalog presentation", () => {
  const account = ProviderInstanceId.make("codex");
  const options = new Map([[account, [{ slug: "default", name: "Default" }]]]);
  it("supplies an off-catalog active identity instead of the first/default model without changing the selectable catalog", () => {
    const selected = { instanceId: account, model: "actual-native-model" };
    const adapted = withLiveComposerPickerOption(options, selected);
    expect(
      resolveModelPickerSelectedModel({
        driverKind: ProviderDriverKind.make("codex"),
        model: selected.model,
        options: adapted.get(account) ?? [],
      }),
    ).toMatchObject({ slug: selected.model, name: selected.model, isUnavailable: true });
    expect(options.get(account)).toHaveLength(1);
    expect(
      liveComposerPickerDisabledReason(options, selected, account, selected.model),
    ).not.toBeNull();
    expect(liveComposerPickerDisabledReason(options, selected, account, "default")).toBeNull();
  });
  it("does not change a known catalog entry or another account's options", () => {
    expect(withLiveComposerPickerOption(options, { instanceId: account, model: "default" })).toBe(
      options,
    );
    const other = ProviderInstanceId.make("other");
    expect(
      withLiveComposerPickerOption(options, { instanceId: other, model: "actual" }).get(account),
    ).toBe(options.get(account));
  });
});

describe("composer carried-menu preflight", () => {
  const base = {
    driver: "claudeAgent",
    routeKind: "server",
    hasPendingProgress: false,
    text: "/rewind",
    attachmentCount: 0,
    hasPendingAttachments: false,
  };
  it("opens bare menus but sends neither attached nor importing commands down the clear-draft menu path", () => {
    expect(typeof resolveChatComposerLocalMenu).toBe("function");
    expect(resolveChatComposerLocalMenu(base)).toBe("rewind");
    expect(resolveChatComposerLocalMenu({ ...base, text: "/config" })).toBe("config");
    expect(resolveChatComposerLocalMenu({ ...base, attachmentCount: 1 })).toBeNull();
    expect(resolveChatComposerLocalMenu({ ...base, hasPendingAttachments: true })).toBeNull();
  });
  it("keeps newline-bearing raw text and existing provider/route/pending gates", () => {
    const raw = { ...base, text: "/config\nkeep this exact text", attachmentCount: 1 };
    const before = JSON.stringify(raw);
    expect(resolveChatComposerLocalMenu(raw)).toBeNull();
    expect(JSON.stringify(raw)).toBe(before);
    expect(resolveChatComposerLocalMenu({ ...base, driver: "codex" })).toBeNull();
    expect(resolveChatComposerLocalMenu({ ...base, routeKind: "draft" })).toBeNull();
    expect(resolveChatComposerLocalMenu({ ...base, hasPendingProgress: true })).toBeNull();
  });
});
