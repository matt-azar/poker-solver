import { create } from "zustand";
import type { BetSizeDisplayMode } from "../domain/betSizes";
import type { ThemePreference } from "../domain/types";

const SETTINGS_KEY = "study-ui-settings-v1";

export interface UiSettings {
  themePreference: ThemePreference;
  evDisplayBasis: "local" | "root_centered";
  betSizeDisplay: BetSizeDisplayMode;
  /** Default merge threshold (%) suggested on new Build spots. */
  defaultMergeThresholdPct: number;
}

export const DEFAULT_UI_SETTINGS: UiSettings = {
  themePreference: "system",
  evDisplayBasis: "local",
  betSizeDisplay: "both",
  defaultMergeThresholdPct: 10,
};

function loadSettings(): UiSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      return { ...DEFAULT_UI_SETTINGS };
    }
    return { ...DEFAULT_UI_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_UI_SETTINGS };
  }
}

function saveSettings(settings: UiSettings) {
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
      : loadSettings(),
  settingsOpen: false,
  setSettingsOpen(open) {
    set({ settingsOpen: open });
  },
  updateSettings(partial) {
    const settings = { ...get().settings, ...partial };
    saveSettings(settings);
    set({ settings });
  },
  resetSettings() {
    const settings = { ...DEFAULT_UI_SETTINGS };
    saveSettings(settings);
    set({ settings });
  },
}));
