import { useEffect, useMemo, useRef } from "react";
import type { BetSizeDisplayMode } from "../../domain/betSizes";
import {
  fastSolveDefaults,
  formatHardwareHint,
} from "../../domain/hardwareDefaults";
import type { ThemePreference } from "../../domain/types";
import { useSettingsStore } from "../../state/settingsStore";
import { useStudyStore } from "../../state/studyStore";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function listFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (node) => !node.hasAttribute("disabled") && node.getAttribute("aria-hidden") !== "true",
  );
}

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
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

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

  useEffect(() => {
    if (!open) {
      return;
    }
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }

    const focusables = listFocusable(dialog);
    (focusables[0] ?? dialog).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const nodes = listFocusable(dialog);
      if (nodes.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || !dialog.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !dialog.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const restore = restoreFocusRef.current;
      if (restore && typeof restore.focus === "function" && document.contains(restore)) {
        restore.focus();
      }
      restoreFocusRef.current = null;
    };
  }, [open, setOpen]);

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
        ref={dialogRef}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
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
            <option value="both">Pot tag + chips (b75 · 75.0 chips)</option>
            <option value="pot">Pot tag only (b75)</option>
            <option value="chips">Chips only (75.0 chips)</option>
          </select>
          <span className="settings-hint">
            Updates Study action blocks and path size tags immediately.
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
          <label className="settings-field" title="How many full EV/gap refreshes to aim for during a solve. Live progress never waits more than 10 iterations between refreshes; Iter n/x updates every iteration.">
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
