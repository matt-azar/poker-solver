import { create } from "zustand";
import type { BetSizeDisplayMode } from "../domain/betSizes";
import type { ThemePreference } from "../domain/types";
import { useThemeStore } from "./themeStore";

const SETTINGS_KEY = "study-ui-settings-v1";

export interface UiSettings {
  /** Mirrored from themeStore — themeStore is the single persisted authority. */
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

type PersistedUiSettings = Omit<UiSettings, "themePreference">;

function loadPersisted(): PersistedUiSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      const { themePreference: _t, ...rest } = DEFAULT_UI_SETTINGS;
      return { ...rest };
    }
    const parsed = JSON.parse(raw) as Partial<UiSettings>;
    const { themePreference: _ignored, ...rest } = {
      ...DEFAULT_UI_SETTINGS,
      ...parsed,
    };
    return rest;
  } catch {
    const { themePreference: _t, ...rest } = DEFAULT_UI_SETTINGS;
    return { ...rest };
  }
}

function savePersisted(settings: UiSettings) {
  try {
    const { themePreference: _ignored, ...rest } = settings;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(rest));
  } catch {
    /* ignore */
  }
}

function withTheme(partial: PersistedUiSettings): UiSettings {
  return {
    ...partial,
    themePreference: useThemeStore.getState().preference,
  };
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
      : withTheme(loadPersisted()),
  settingsOpen: false,
  setSettingsOpen(open) {
    set({ settingsOpen: open });
  },
  updateSettings(partial) {
    if (partial.themePreference !== undefined) {
      useThemeStore.getState().setPreference(partial.themePreference);
    }
    const settings: UiSettings = {
      ...get().settings,
      ...partial,
      themePreference: useThemeStore.getState().preference,
    };
    savePersisted(settings);
    set({ settings });
  },
  resetSettings() {
    useThemeStore.getState().setPreference(DEFAULT_UI_SETTINGS.themePreference);
    const settings = withTheme({
      evDisplayBasis: DEFAULT_UI_SETTINGS.evDisplayBasis,
      betSizeDisplay: DEFAULT_UI_SETTINGS.betSizeDisplay,
      defaultMergeThresholdPct: DEFAULT_UI_SETTINGS.defaultMergeThresholdPct,
    });
    savePersisted(settings);
    set({ settings });
  },
}));

// Keep Settings UI in sync when Theme button / themeStore changes preference.
useThemeStore.subscribe((state) => {
  const current = useSettingsStore.getState().settings;
  if (current.themePreference === state.preference) {
    return;
  }
  useSettingsStore.setState({
    settings: { ...current, themePreference: state.preference },
  });
});
