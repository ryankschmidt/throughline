import { describe, expect, it } from "vite-plus/test";
import { composerAttachmentPreview } from "./composerAttachmentPreview";

describe("collapsed draft attachment previews", () => {
  it("opens legacy pasted pictures using the real image bytes", () => {
    const attachment = {
      type: "image" as const,
      id: "i",
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 10,
      previewUri: "file:///preview.png",
      dataUrl: "data:image/png;base64,YQ==",
    };
    expect(composerAttachmentPreview(attachment)).toEqual({
      kind: "preview",
      source: {
        kind: "image",
        name: "screen.png",
        uri: attachment.dataUrl,
        sourceIdentifier: "draft-image:i",
      },
    });
  });
  it("keeps owned image files on the existing lease/container-rebase path", () => {
    const attachment = {
      type: "file" as const,
      id: "i",
      name: "photo.png",
      mimeType: "image/png",
      sizeBytes: 10,
      fileUri: "file:///photo.png",
    };
    const target = composerAttachmentPreview(attachment);
    expect(target.kind).toBe("preview");
    if (target.kind !== "preview") throw new Error("Not a preview");
    expect(target.source).toMatchObject({
      kind: "image",
      attachment: { fileUri: attachment.fileUri, type: "image" },
      sourceIdentifier: "draft-image:i",
    });
    expect(target.source).not.toHaveProperty("uri");
  });
  it("keeps PDF, video and document opening behavior", () => {
    const attachment = {
      type: "file" as const,
      id: "f",
      name: "file",
      mimeType: "application/pdf",
      sizeBytes: 10,
      fileUri: "file:///file",
    };
    expect(composerAttachmentPreview(attachment)).toEqual({
      kind: "preview",
      source: { kind: "pdf", name: "file", attachment, sourceIdentifier: "draft-file:f" },
    });
    const video = { ...attachment, name: "clip.mp4", mimeType: "video/mp4" };
    expect(composerAttachmentPreview(video)).toEqual({
      kind: "video",
      attachment: video,
      sourceIdentifier: "draft:f",
    });
    const document = { ...attachment, name: "notes.txt", mimeType: "text/plain" };
    expect(composerAttachmentPreview(document)).toEqual({ kind: "document", attachment: document });
  });
});
