import { lazy, Suspense, useEffect } from "react";
import { Modal, View, Pressable } from "react-native";
import { NavigationContainer, NavigationIndependentTree } from "@react-navigation/native";
import { createV5StackNavigator } from "../../native/createV5StackNavigator";
import { CustomSnoozeSheet } from "../../features/threads/CustomSnoozeSheet";
import {
  SettingsEnvironmentFilterProvider,
  useSettingsEnvironmentFilter,
} from "../../features/settings/settings-environment-filter";
import { AppText } from "../../components/AppText";
import { useMobileNavigationTheme } from "../../lib/useMobileNavigationTheme";
import type { useDesktopThreadMenu } from "./useDesktopThreadMenu";

// The thread list renders these sheets, and project settings reach back through the workspace
// layout into that list; loading the screen on open keeps the import graph acyclic.
const SettingsProjectOverviewRouteScreen = lazy(async () => ({
  default: (await import("../../features/settings/SettingsProjectOverviewRouteScreen"))
    .SettingsProjectOverviewRouteScreen,
}));

const ProjectStack = createV5StackNavigator<{ Project: undefined }>();
type Menu = ReturnType<typeof useDesktopThreadMenu>;
function ScopedProjectSettings({ menu }: { menu: Menu }) {
  const filter = useSettingsEnvironmentFilter();
  const group = filter.projectGroups.find((group) =>
    group.members.some(
      (member) =>
        member.project.environmentId === menu.projectRef.environmentId &&
        member.project.id === menu.projectRef.projectId,
    ),
  );
  useEffect(() => {
    if (group) filter.selectProject(group.key);
    // The desktop action targets the thread's owning environment, not all hosts.
    for (const target of filter.selectedTargets) {
      if (target.environmentId !== menu.projectRef.environmentId)
        filter.toggleEnvironment(target.environmentId);
    }
  }, [group?.key, filter.selectProject, menu.projectRef.environmentId]);
  return (
    <Suspense fallback={null}>
      <SettingsProjectOverviewRouteScreen />
    </Suspense>
  );
}
export function ThreadMenuSheets({ menu }: { menu: Menu }) {
  const theme = useMobileNavigationTheme();
  return (
    <>
      {menu.customSnoozeOpen ? (
        <CustomSnoozeSheet onClose={menu.closeCustomSnooze} onSnooze={menu.onSnooze} />
      ) : null}
      <Modal
        visible={menu.projectSettingsOpen}
        presentationStyle="pageSheet"
        onRequestClose={menu.closeProjectSettings}
      >
        <View className="flex-1 bg-screen">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close project settings"
            onPress={menu.closeProjectSettings}
            className="px-5 pt-5 pb-2"
          >
            <AppText>Done</AppText>
          </Pressable>
          <NavigationIndependentTree>
            <NavigationContainer theme={theme}>
              <SettingsEnvironmentFilterProvider>
                <ProjectStack.Navigator>
                  <ProjectStack.Screen name="Project" options={{ headerShown: false }}>
                    {() => <ScopedProjectSettings menu={menu} />}
                  </ProjectStack.Screen>
                </ProjectStack.Navigator>
              </SettingsEnvironmentFilterProvider>
            </NavigationContainer>
          </NavigationIndependentTree>
        </View>
      </Modal>
    </>
  );
}
