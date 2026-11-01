import { useEffect, useMemo } from "react";
import type { BetSizeDisplayMode } from "../../domain/betSizes";
import {
  fastSolveDefaults,
  formatHardwareHint,
} from "../../domain/hardwareDefaults";
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
  const draft = useStudyStore((s) => s.draft);
  const updateDraft = useStudyStore((s) => s.updateDraft);
  const machineDefaults = useMemo(() => fastSolveDefaults(), []);
  const hardwareHint = formatHardwareHint(machineDefaults);

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

        <h3 className="build-subhead">Solve</h3>
        <p className="settings-hint">
          Fast defaults · {hardwareHint}
        </p>
        <div className="settings-grid">
          <label className="settings-field">
            Algorithm
            <select
              value={draft.algorithm}
              onChange={(event) => updateDraft({ algorithm: event.target.value })}
            >
              <option value="cfr_plus">CFR+</option>
              <option value="cfr">Vanilla CFR</option>
              <option value="dcfr">DCFR</option>
            </select>
          </label>
          <label className="settings-field">
            Samples
            <input
              type="number"
              min={0}
              value={draft.samples}
              onChange={(event) => updateDraft({ samples: Number(event.target.value) })}
            />
          </label>
          <label className="settings-field">
            Threads
            <input
              type="number"
              min={1}
              max={64}
              value={draft.threads}
              onChange={(event) =>
                updateDraft({ threads: Number(event.target.value), frozen: true })
              }
            />
          </label>
          <label className="settings-field">
            Memory MiB
            <input
              type="number"
              min={64}
              value={draft.memoryMib}
              onChange={(event) => updateDraft({ memoryMib: Number(event.target.value) })}
            />
          </label>
        </div>
        <label className="settings-field">
          Solution path
          <input
            value={draft.solutionPath}
            placeholder="/tmp/spot.psol"
            onChange={(event) => updateDraft({ solutionPath: event.target.value })}
          />
        </label>
        <label className="settings-field">
          Incentives
          <input
            value={draft.incentives}
            placeholder="label 0 b100 3.5; tag 1 bluff -2"
            onChange={(event) => updateDraft({ incentives: event.target.value })}
          />
        </label>
        <label className="settings-field">
          Edge tags
          <input
            value={draft.edgeTags}
            placeholder="b100 bluff; 1 f give_up"
            onChange={(event) => updateDraft({ edgeTags: event.target.value })}
          />
        </label>

        <label className="settings-check">
          <input
            type="checkbox"
            checked={draft.useIcm}
            onChange={(event) => updateDraft({ useIcm: event.target.checked })}
          />
          Use ICM
        </label>
        {draft.useIcm ? (
          <>
            <label className="settings-field">
              ICM stacks
              <input
                value={draft.icmStacks}
                placeholder="1000, 1000, 1000"
                onChange={(event) => updateDraft({ icmStacks: event.target.value })}
              />
            </label>
            <label className="settings-field">
              ICM payouts
              <input
                value={draft.icmPayouts}
                placeholder="500, 300, 200"
                onChange={(event) => updateDraft({ icmPayouts: event.target.value })}
              />
              <span className="settings-hint">
                Stacks need at least two seats. Places without a payout pay 0.
              </span>
            </label>
          </>
        ) : (
          <span className="settings-hint">
            Chip EV is used until ICM is checked. A normal solve does not send tournament stacks.
          </span>
        )}

        <div className="settings-actions">
          <button
            type="button"
            className="toolbar-btn"
            onClick={() =>
              updateDraft({
                threads: machineDefaults.threads,
                memoryMib: machineDefaults.memoryMib,
                frozen: true,
              })
            }
          >
            Reset to fast
          </button>
          <button type="button" className="toolbar-btn" onClick={resetSettings}>
            Reset display defaults
          </button>
        </div>
      </div>
    </div>
  );
}
