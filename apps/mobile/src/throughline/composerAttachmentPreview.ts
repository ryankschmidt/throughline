import { imageMimeType } from "@t3tools/shared/image";
import { videoMimeType } from "@t3tools/shared/video";
import { isPdfFile } from "../lib/filePreview";
import type { DraftComposerAttachment } from "../lib/composerImages";
import type { FilePreviewSource } from "../components/FilePreviewModal.types";

/** Collapsed chips keep the same owned-file previews as the full thumbnail strip. */
export function composerAttachmentPreview(attachment: DraftComposerAttachment) {
  if (attachment.type === "image" || imageMimeType(attachment) !== null) {
    const { source: _source, ...rest } = attachment;
    const image =
      attachment.type === "image"
        ? attachment
        : { ...rest, type: "image" as const, previewUri: attachment.fileUri };
    const source: FilePreviewSource = {
      kind: "image",
      name: image.name,
      sourceIdentifier: `draft-image:${image.id}`,
      ...(image.fileUri !== undefined
        ? { attachment: { ...image, fileUri: image.fileUri } }
        : { uri: image.dataUrl ?? image.previewUri }),
    };
    return { kind: "preview" as const, source };
  }
  if (videoMimeType(attachment) !== null)
    return { kind: "video" as const, attachment, sourceIdentifier: `draft:${attachment.id}` };
  if (isPdfFile(attachment)) {
    const source: FilePreviewSource = {
      kind: "pdf",
      name: attachment.name,
      attachment,
      sourceIdentifier: `draft-file:${attachment.id}`,
    };
    return { kind: "preview" as const, source };
  }
  return { kind: "document" as const, attachment };
}
