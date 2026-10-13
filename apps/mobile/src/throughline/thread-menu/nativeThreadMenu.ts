import type { NativeStackHeaderItemMenu } from "@react-navigation/native-stack";
import type { ContextMenuItem } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
// Native icon names are presentation only; labels, ordering and state come from desktop.
type NativeMenuSymbol = Extract<
  NonNullable<NativeStackHeaderItemMenu["icon"]>,
  { type: "sfSymbol" }
>["name"];
const symbols: Readonly<Record<string, NativeMenuSymbol>> = {
  copy: "doc.on.doc",
  hash: "number",
  folder: "folder",
  "git-branch": "arrow.triangle.branch",
  "message-square-plus": "square.and.pencil",
  pin: "pin",
  "pin-off": "pin.slash",
  "circle-check": "checkmark.circle",
  clock: "clock",
  pencil: "pencil",
  "refresh-cw": "arrow.clockwise",
  "mail-open": "envelope.open",
  "folder-tree": "folder",
  timer: "timer",
  settings: "gearshape",
  archive: "archivebox",
  trash: "trash",
};
export function nativeThreadMenuActions(
  items: ReadonlyArray<ContextMenuItem<string>>,
): MenuAction[] {
  return items.map((item) => ({
    id: item.id,
    title: item.label,
    ...(item.icon ? { image: symbols[item.icon] } : {}),
    attributes: { disabled: item.disabled === true, destructive: item.destructive === true },
    ...(item.checked !== undefined
      ? { state: item.checked ? ("on" as const) : ("off" as const) }
      : {}),
    ...(item.children ? { subactions: nativeThreadMenuActions(item.children) } : {}),
  }));
}
export function iosThreadMenuItems(
  items: ReadonlyArray<ContextMenuItem<string>>,
  onSelect: (id: string) => void,
): NativeStackHeaderItemMenu["menu"]["items"] {
  return items.map((item) => {
    const icon = item.icon ? symbols[item.icon] : undefined;
    return {
      label: item.label,
      disabled: item.disabled === true,
      destructive: item.destructive === true,
      ...(icon ? { icon: { name: icon, type: "sfSymbol" as const } } : {}),
      ...(item.children
        ? {
            type: "submenu",
            items: iosThreadMenuItems(item.children, onSelect),
          }
        : { type: "action", state: item.checked ? "on" : "off", onPress: () => onSelect(item.id) }),
    };
  });
}
