import type { ComponentProps } from "react";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { ThreadHeader } from "../../features/threads/ThreadHeader";
import { useDesktopThreadMenu } from "./useDesktopThreadMenu";
import { ThreadMenuSheets } from "./ThreadMenuSheets";

export function ThreadMenuHeader(
  props: Omit<ComponentProps<typeof ThreadHeader>, "threadMenu"> & {
    menuThread: EnvironmentThreadShell;
    menuProject: EnvironmentProject | null;
  },
) {
  const menu = useDesktopThreadMenu(props.menuThread, props.menuProject, "header");
  return (
    <>
      <ThreadHeader {...props} threadMenu={menu} />
      <ThreadMenuSheets menu={menu} />
    </>
  );
}
