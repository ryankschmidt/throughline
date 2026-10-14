// @effect-diagnostics nodeBuiltinImport:off -- Read-only finite source-consumer witness; not mounted/native acceptance.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const source = NodeFS.readFileSync(
  new URL("../../components/chat/ChatComposer.tsx", import.meta.url),
  "utf8",
);
describe("approved actual ChatComposer voice consumers (source-only)", () => {
  it("binds protected thread draft/selection ports to the phone lifecycle adapter", () => {
    expect(source).toContain("const desktopVoice = useDesktopVoiceInput(");
    expect(source).toContain("ownerKey: optimizationOwner");
    expect(source).toContain("revision: optimizationRevisionRef.current");
  });
  it("blocks actual submission and freezes the actual prompt editor while voice is busy", () => {
    const submit = source.slice(
      source.indexOf("const submitComposer ="),
      source.indexOf("const handleSubmitMessage ="),
    );
    expect(submit).toContain("desktopVoice.blocksSubmission");
    const editor = source.slice(
      source.indexOf("<ComposerPromptEditor\n"),
      source.indexOf("<ComposerPromptEditor\n") + 5400,
    );
    expect(editor).toContain("desktopVoice.freezesEditor");
  });
  it("mounts the fork microphone immediately before the real footer send controls, including resting mode", () => {
    const mount = source.indexOf("<DesktopVoiceControl\n");
    expect(mount).toBeGreaterThan(0);
    const footer = source.indexOf("<ComposerFooterPrimaryActions", mount);
    expect(source.slice(mount, footer)).toContain("voice={desktopVoice}");
    expect(source.slice(mount, footer)).toMatch(/^<DesktopVoiceControl[^]*?\/>(\s*)$/);
  });
});
