import { useEffect, useRef } from "react";
import type { BetSizeDisplayMode } from "../../domain/betSizes";
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

/** Display preferences only — per-solve threads/memory live beside Build. */
export function SettingsDialog() {
  const open = useSettingsStore((s) => s.settingsOpen);
  const setOpen = useSettingsStore((s) => s.setSettingsOpen);
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const resetSettings = useSettingsStore((s) => s.resetSettings);
  const setThemePreference = useStudyStore((s) => s.setThemePreference);
  const setEvDisplayBasis = useStudyStore((s) => s.setEvDisplayBasis);
  const evDisplayBasis = useStudyStore((s) => s.evDisplayBasis);
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
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

        <p className="settings-hint">
          Display preferences. Threads, memory, and samples are set on Build.
        </p>

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
            Updates Study action blocks immediately. The betting path stays pot-fraction abbreviations (x, c, b20).
          </span>
        </label>

        <div className="settings-actions">
          <button type="button" className="toolbar-btn" onClick={resetSettings}>
            Reset display defaults
          </button>
        </div>
      </div>
    </div>
  );
}
