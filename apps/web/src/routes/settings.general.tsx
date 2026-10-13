import { createFileRoute } from "@tanstack/react-router";

import { GeneralSettingsPanel } from "../components/settings/SettingsPanels";
import { SettingsVoiceOptimizationSection } from "../throughline/composer-optimize/SettingsVoiceOptimizationSection";

function SettingsGeneralRoute() {
  return (
    <>
      <GeneralSettingsPanel />
      <SettingsVoiceOptimizationSection />
    </>
  );
}

export const Route = createFileRoute("/settings/general")({
  component: SettingsGeneralRoute,
});
