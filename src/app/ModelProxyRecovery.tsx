import { useState } from "react";
import {
  modelProxyRecovery,
  saveModelProxyRecovery,
  type ModelProxyRecovery as Recovery,
} from "../features/agents/model-proxy-recovery";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { SwitchPreferenceRow } from "../shared/design-system/ui/SwitchPreferenceRow";

export function ModelProxyRecovery({ plugin }: { plugin: string }) {
  const [settings, setSettings] = useState<Recovery>(() => {
    try {
      return modelProxyRecovery(plugin);
    } catch {
      return { retry: false, fallback: false };
    }
  });
  const [error, setError] = useState("");
  function save(next: Recovery) {
    try {
      saveModelProxyRecovery(plugin, next);
      setSettings(next);
      setError("");
    } catch {
      setError("Recovery settings could not be saved.");
    }
  }
  return (
    <section aria-label="Model proxy recovery">
      <SettingsGroup>
        <SwitchPreferenceRow
          label="Retry failed model transformations"
          description="Try this plugin once more after a failed callback. A callback still running after a timeout is not retried."
          checked={settings.retry}
          onCheckedChange={(retry) => save({ ...settings, retry })}
        />
        <SwitchPreferenceRow
          label="Continue if this model proxy fails"
          description="Skip this plugin after failure and send the request without its changes. This can restore context it removed. Other model proxy plugins still run."
          checked={settings.fallback}
          onCheckedChange={(fallback) => save({ ...settings, fallback })}
        />
      </SettingsGroup>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
