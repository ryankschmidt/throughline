import { Pressable, ScrollView, View } from "react-native";
import type { ComposerAttachmentStripProps } from "../components/ComposerAttachmentStrip";
import { ComposerAttachmentThumbnail } from "../components/ComposerAttachmentStrip";
import { AppText as Text } from "../components/AppText";
import { SymbolView } from "../components/AppSymbol";
import { composerAttachmentPreview } from "./composerAttachmentPreview";

/** Preview is modal: dismissing returns to these same small, removable chips. */
export function ComposerCollapsedAttachments(props: ComposerAttachmentStripProps) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="always"
      className="grow-0"
      contentContainerClassName="flex-row gap-2"
    >
      {props.attachments.map((attachment) => (
        <View
          key={attachment.id}
          className="h-11 max-w-[240px] flex-row items-center rounded-full bg-subtle"
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Preview ${attachment.name}`}
            className="h-11 min-w-0 shrink flex-row items-center gap-2 pl-2 pr-3 active:opacity-70"
            onPress={() => {
              const target = composerAttachmentPreview(attachment);
              if (target.kind === "preview") props.onPressPreview?.(target.source);
              else if (target.kind === "video")
                props.onPressVideo?.(target.attachment, target.sourceIdentifier);
              else props.onPressDocument?.(target.attachment);
            }}
          >
            <View pointerEvents="none">
              <ComposerAttachmentThumbnail
                environmentId={props.environmentId}
                attachment={attachment}
                size={24}
                borderRadius={6}
                compact
              />
            </View>
            <Text numberOfLines={1} className="min-w-0 shrink text-sm text-foreground">
              {props.attachments.length === 1 ? "1 attachment" : attachment.name}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Remove ${attachment.name}`}
            className="h-11 w-11 items-center justify-center border-l border-border-subtle active:opacity-70"
            onPress={() => props.onRemove(attachment.id)}
          >
            <SymbolView name="xmark" size={15} tintColorClassName="accent-foreground" />
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}
