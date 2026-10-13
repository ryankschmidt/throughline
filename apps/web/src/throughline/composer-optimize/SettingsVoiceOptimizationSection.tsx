import { useState } from "react";
import { CheckIcon } from "lucide-react";
import { SettingsPageContainer, SettingsSection } from "../../components/settings/settingsLayout";
import { OPTIMIZER_PROVIDER_OPTIONS } from "./optimizerPreference";
import { saveOptimizerPreference, useOptimizerPreference } from "./useOptimizerPreference";

export function SettingsVoiceOptimizationSection() {
  const provider = useOptimizerPreference();
  const [saveFailed, setSaveFailed] = useState(false);
  return (
    <SettingsPageContainer>
      <SettingsSection id="voice-message-optimizer" title="Voice Message Optimizer">
        <div role="radiogroup" aria-label="Voice Message Optimizer">
          {OPTIMIZER_PROVIDER_OPTIONS.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer items-center justify-between gap-4 p-4 [&+*]:border-t [&+*]:border-border/50 focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring"
            >
              <input
                type="radio"
                name="voice-message-optimizer"
                value={option.value}
                className="sr-only"
                checked={provider === option.value}
                onChange={() => setSaveFailed(!saveOptimizerPreference(option.value))}
              />
              {option.label}
              {provider === option.value ? <CheckIcon className="size-4" aria-hidden /> : null}
            </label>
          ))}
        </div>
      </SettingsSection>
      {saveFailed ? (
        <p role="alert" className="px-4 text-sm text-muted-foreground">
          Could not save; previous choice kept.
        </p>
      ) : null}
    </SettingsPageContainer>
  );
}
