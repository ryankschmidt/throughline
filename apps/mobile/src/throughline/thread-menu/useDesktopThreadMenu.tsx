import { appAtomRegistry } from "../../state/atom-registry";
import { nativeMenuSessionUuid } from "./threadMenuIdentity";
import { useMemo, useState } from "react";
import { useNavigation } from "@react-navigation/native";
import { Alert } from "react-native";
import * as Option from "effect/Option";
import {
  buildThreadActionMenuItems,
  threadActionRequiresOperate,
} from "@t3tools/client-runtime/throughline/threadActionMenu";
import {
  canSnooze,
  effectiveSnoozed,
  resolveSnoozePresets,
} from "@t3tools/client-runtime/state/thread-settled";
import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import type {
  EnvironmentThreadShell,
  EnvironmentProject,
} from "@t3tools/client-runtime/state/shell";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useThreadListActions } from "../../features/home/useThreadListActions";
import { useHomeListOptions } from "../../features/home/home-list-options";
import { buildHomeProjectScopes } from "../../features/home/homeThreadList";
import { useProjects, useServerConfigs } from "../../state/entities";
import { useEnvironmentScope, readEnvironmentScope } from "../../state/session";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { nativeThreadMenuActions, iosThreadMenuItems } from "./nativeThreadMenu";

/** Desktop owns the items; existing mobile commands own mutations. */
export function useDesktopThreadMenu(
  thread: EnvironmentThreadShell,
  project: EnvironmentProject | null,
  surface: "header" | "list",
) {
  const navigation = useNavigation();
  const actions = useThreadListActions();
  const markUnread = useAtomCommand(threadEnvironment.markUnread);
  const projects = useProjects();
  const configs = useServerConfigs();
  const available = useMemo(() => new Set(configs.keys()), [configs]);
  const filters = useHomeListOptions(available);
  const scopes = buildHomeProjectScopes({
    projects,
    environmentId: filters.options.selectedEnvironmentId,
    projectGroupingMode: filters.options.projectGroupingMode,
  });
  const scope = scopes.find((s) =>
    s.projectRefs.some(
      (ref) => ref.environmentId === thread.environmentId && ref.projectId === thread.projectId,
    ),
  );
  const canOperate = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  // Match desktop: read the owning cached projection, never subscribe every sidebar row to full histories.
  const projection = Option.getOrNull(
    appAtomRegistry.get(
      environmentThreadDetails.stateAtom({
        environmentId: thread.environmentId,
        threadId: thread.id,
      }),
    ).data,
  );
  const sessionUuid = nativeMenuSessionUuid(thread.id, projection);
  const capabilities = configs.get(thread.environmentId)?.environment.capabilities;
  const [customSnoozeOpen, setCustomSnoozeOpen] = useState(false);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const key = `${thread.environmentId}:${thread.id}`;
  const [boundIdentity, setBoundIdentity] = useState(key);
  if (boundIdentity !== key) {
    setBoundIdentity(key);
    setCustomSnoozeOpen(false);
    setProjectSettingsOpen(false);
  }
  const presets = resolveSnoozePresets(new Date());
  const items = buildThreadActionMenuItems({
    canOperate,
    branch: thread.branch,
    sessionUuid,
    transcriptPath: null,
    projectFilter:
      surface === "list" && scope
        ? { label: scope.title, isActive: filters.options.selectedProjectKey === scope.key }
        : null,
    isPinned: thread.pinnedAt != null,
    isSettled: thread.settledOverride === "settled",
    autoSettleEnabled: thread.autoSettleDisabledAt == null,
    isSnoozed: effectiveSnoozed(thread, { now: new Date().toISOString() }),
    canSnoozeNow: canSnooze(thread, { now: new Date().toISOString() }),
    isRegeneratingTitle: thread.titleRegeneration != null,
    isRunning: !threadRuntimeCanArchive(thread.runtime),
    supports: {
      pinning: capabilities?.threadPinning === true,
      settlement: capabilities?.threadSettlement === true,
      snooze: capabilities?.threadSnooze === true,
      autoSettleOptOut: capabilities?.threadAutoSettleOptOut === true,
      titleRegeneration: capabilities?.threadTitleRegeneration === true,
    },
    snoozePresets: presets,
  });
  const select = async (id: string) => {
    const find = (tree: typeof items): (typeof items)[number] | undefined => {
      for (const item of tree) {
        if (item.id === id) return item;
        if (item.children) {
          const child = find(item.children);
          if (child) return child;
        }
      }
    };
    const item = find(items);
    if (!item || item.children || item.disabled) return;
    if (
      threadActionRequiresOperate(item.id) &&
      !readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    switch (item.id) {
      case "new-thread-on-branch":
        navigation.navigate("NewTaskSheet", {
          screen: "NewTaskDraft",
          params: {
            environmentId: String(thread.environmentId),
            projectId: String(thread.projectId),
            branch: thread.branch,
            worktreePath: thread.worktreePath,
          },
        });
        return;
      case "pin":
        await actions.pinThread(thread);
        return;
      case "unpin":
        await actions.unpinThread(thread);
        return;
      case "settle":
        await actions.settleThread(thread);
        return;
      case "unsettle":
        await actions.unsettleThread(thread);
        return;
      case "unsnooze":
        await actions.unsnoozeThread(thread);
        return;
      case "rename":
        actions.renameThread(thread);
        return;
      case "regenerate-title":
        await actions.regenerateThreadTitle(thread);
        return;
      case "auto-settle:enabled":
        await actions.setThreadAutoSettle(thread, true);
        return;
      case "auto-settle:disabled":
        await actions.setThreadAutoSettle(thread, false);
        return;
      case "mark-unread":
        await markUnread({ environmentId: thread.environmentId, input: { threadId: thread.id } });
        return;
      case "filter-by-project":
        if (scope)
          filters.setSelectedProjectKey(
            filters.options.selectedProjectKey === scope.key ? null : scope.key,
          );
        return;
      case "project-settings":
        setProjectSettingsOpen(true);
        return;
      case "archive":
        actions.archiveThread(thread);
        return;
      case "delete":
        actions.confirmDeleteThread(thread);
        return;
      case "snooze:custom":
        setCustomSnoozeOpen(true);
        return;
      case "copy-path":
      case "copy-branch":
      case "copy-thread-id":
      case "copy-session-uuid":
      case "copy-transcript-path": {
        const value =
          item.id === "copy-path"
            ? (thread.worktreePath ?? project?.workspaceRoot)
            : item.id === "copy-branch"
              ? thread.branch
              : item.id === "copy-thread-id"
                ? thread.id
                : item.id === "copy-session-uuid"
                  ? sessionUuid
                  : null;
        if (value && !(await tryCopyTextWithHaptic(value, { target: item.label })))
          Alert.alert("Copy failed", "Clipboard did not accept the value.");
        return;
      }
      default:
        if (item.id.startsWith("snooze:")) {
          const preset = presets.find((p) => `snooze:${p.id}` === item.id);
          if (preset && Date.parse(preset.snoozedUntil) > Date.now())
            await actions.snoozeThread(thread, preset.snoozedUntil);
          else
            Alert.alert(
              "Could not snooze thread",
              "That snooze time has passed. Choose another time.",
            );
        }
    }
  };
  const onSelect = (id: string) => {
    void select(id).catch((error) =>
      Alert.alert("Thread action failed", error instanceof Error ? error.message : String(error)),
    );
  };
  return {
    actions: nativeThreadMenuActions(items),
    iosItems: iosThreadMenuItems(items, onSelect),
    onPressAction: ({ nativeEvent }: { nativeEvent: { event: string } }) =>
      onSelect(nativeEvent.event),
    customSnoozeOpen,
    closeCustomSnooze: () => setCustomSnoozeOpen(false),
    onSnooze: (until: string) => {
      void actions.snoozeThread(thread, until);
      setCustomSnoozeOpen(false);
    },
    projectSettingsOpen,
    closeProjectSettings: () => setProjectSettingsOpen(false),
    projectRef: { environmentId: thread.environmentId, projectId: thread.projectId },
  };
}
