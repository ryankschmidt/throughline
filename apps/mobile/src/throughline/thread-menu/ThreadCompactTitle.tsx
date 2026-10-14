import { View, useWindowDimensions } from "react-native";

import { AppText } from "../../components/AppText";
import { compactThreadTitleWidth } from "./threadHeaderLayout";

/** The compact thread title that sits before the thread menu, as on desktop. */
export function ThreadCompactTitle(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly leadingButtons: number;
  readonly trailingButtons: number;
}) {
  const { width } = useWindowDimensions();
  const titleWidth = compactThreadTitleWidth({
    windowWidth: width,
    leadingButtons: props.leadingButtons,
    trailingButtons: props.trailingButtons,
  });
  return (
    <View style={{ width: titleWidth, height: 44, justifyContent: "center" }}>
      <AppText numberOfLines={1} className="text-[17px] font-extrabold accent-header-foreground">
        {props.title}
      </AppText>
      {props.subtitle ? (
        <AppText numberOfLines={1} className="text-[13px] accent-muted-foreground">
          {props.subtitle}
        </AppText>
      ) : null}
    </View>
  );
}
