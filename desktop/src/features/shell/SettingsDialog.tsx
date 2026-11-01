import { useEffect } from "react";
import type { BetSizeDisplayMode } from "../../domain/betSizes";
import type { ThemePreference } from "../../domain/types";
import { useSettingsStore } from "../../state/settingsStore";
import { useStudyStore } from "../../state/studyStore";

export function SettingsDialog() {
  const open = useSettingsStore((s) => s.settingsOpen);
  const setOpen = useSettingsStore((s) => s.setSettingsOpen);
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const resetSettings = useSettingsStore((s) => s.resetSettings);
  const setThemePreference = useStudyStore((s) => s.setThemePreference);
  const setEvDisplayBasis = useStudyStore((s) => s.setEvDisplayBasis);
  const evDisplayBasis = useStudyStore((s) => s.evDisplayBasis);

  useEffect(() => {
    if (!open) {
      return;
    }
    // Align study store when Settings opens / values change from this dialog.
    setEvDisplayBasis(settings.evDisplayBasis);
    setThemePreference(settings.themePreference);
  }, [
    open,
    settings.evDisplayBasis,
    settings.themePreference,
    setEvDisplayBasis,
    setThemePreference,
  ]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="settings-overlay"
      role="presentation"
      onClick={() => setOpen(false)}
    >
      <div
        className="settings-dialog"
        role="dialog"
        aria-label="Settings"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="panel-title-row">
          <h2 className="panel-title">Settings</h2>
          <button type="button" className="toolbar-btn" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>

        <label className="settings-field">
          Theme
          <select
            value={settings.themePreference}
            onChange={(event) => {
              const value = event.target.value as ThemePreference;
              updateSettings({ themePreference: value });
              setThemePreference(value);
            }}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>

        <label className="settings-field">
          EV display
          <select
            value={settings.evDisplayBasis}
            onChange={(event) => {
              const value =
                event.target.value === "root_centered" ? "root_centered" : "local";
              updateSettings({ evDisplayBasis: value });
              setEvDisplayBasis(value);
            }}
          >
            <option value="local">Local EV (Fold = 0)</option>
            <option value="root_centered">Global EV (root-centered)</option>
          </select>
          <span className="settings-hint">
            Current study view: {evDisplayBasis === "local" ? "Local" : "Global"}
          </span>
        </label>

        <label className="settings-field">
          Bet size labels
          <select
            value={settings.betSizeDisplay}
            onChange={(event) =>
              updateSettings({
                betSizeDisplay: event.target.value as BetSizeDisplayMode,
              })
            }
          >
            <option value="both">Pot tag + chips (b75 · 75.0)</option>
            <option value="pot">Pot tag only (b75)</option>
            <option value="chips">Chips only (75.0)</option>
          </select>
        </label>

        <label className="settings-field">
          Default size-merge threshold (%)
          <input
            type="number"
            min={0}
            max={50}
            step={1}
            value={settings.defaultMergeThresholdPct}
            onChange={(event) =>
              updateSettings({
                defaultMergeThresholdPct: Number(event.target.value) || 0,
              })
            }
          />
          <span className="settings-hint">
            Used as the Build default for merging near bet sizes (Pio-style).
          </span>
        </label>

        <div className="settings-actions">
          <button type="button" className="toolbar-btn" onClick={resetSettings}>
            Reset defaults
          </button>
        </div>
      </div>
    </div>
  );
}
