import { create } from "zustand";
import type { BetSizeDisplayMode } from "../domain/betSizes";

const SETTINGS_KEY = "study-ui-settings-v1";

export interface UiSettings {
  evDisplayBasis: "local" | "root_centered";
  betSizeDisplay: BetSizeDisplayMode;
}

export const DEFAULT_UI_SETTINGS: UiSettings = {
  evDisplayBasis: "local",
  betSizeDisplay: "both",
};

function loadPersisted(): UiSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<UiSettings> & { themePreference?: string }) : {};
    // Drop any legacy themePreference from the blob on read.
    if (parsed.themePreference !== undefined) {
      const { themePreference: _drop, ...rest } = parsed;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        evDisplayBasis:
          rest.evDisplayBasis === "root_centered" ? "root_centered" : "local",
        betSizeDisplay:
          rest.betSizeDisplay === "pot" || rest.betSizeDisplay === "chips"
            ? rest.betSizeDisplay
            : DEFAULT_UI_SETTINGS.betSizeDisplay,
      }));
    }
    return {
      evDisplayBasis:
        parsed.evDisplayBasis === "root_centered" ? "root_centered" : "local",
      betSizeDisplay:
        parsed.betSizeDisplay === "pot" || parsed.betSizeDisplay === "chips"
          ? parsed.betSizeDisplay
          : DEFAULT_UI_SETTINGS.betSizeDisplay,
    };
  } catch {
    return { ...DEFAULT_UI_SETTINGS };
  }
}

function savePersisted(settings: UiSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

interface SettingsState {
  settings: UiSettings;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  updateSettings: (partial: Partial<UiSettings>) => void;
  resetSettings: () => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings:
    typeof localStorage === "undefined"
      ? { ...DEFAULT_UI_SETTINGS }
      : loadPersisted(),
  settingsOpen: false,
  setSettingsOpen(open) {
    set({ settingsOpen: open });
  },
  updateSettings(partial) {
    const settings: UiSettings = {
      ...get().settings,
      ...partial,
    };
    savePersisted(settings);
    set({ settings });
  },
  resetSettings() {
    const settings = { ...DEFAULT_UI_SETTINGS };
    savePersisted(settings);
    set({ settings });
  },
}));
