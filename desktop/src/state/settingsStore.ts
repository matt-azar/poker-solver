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
}

export const DEFAULT_UI_SETTINGS: UiSettings = {
  themePreference: "system",
  evDisplayBasis: "local",
  betSizeDisplay: "both",
};

type PersistedUiSettings = Omit<UiSettings, "themePreference">;

function loadPersisted(): PersistedUiSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const parsed = raw
      ? (JSON.parse(raw) as Partial<PersistedUiSettings>)
      : {};
    return {
      evDisplayBasis:
        parsed.evDisplayBasis === "root_centered" ? "root_centered" : "local",
      betSizeDisplay:
        parsed.betSizeDisplay === "pot" || parsed.betSizeDisplay === "chips"
          ? parsed.betSizeDisplay
          : DEFAULT_UI_SETTINGS.betSizeDisplay,
    };
  } catch {
    return {
      evDisplayBasis: DEFAULT_UI_SETTINGS.evDisplayBasis,
      betSizeDisplay: DEFAULT_UI_SETTINGS.betSizeDisplay,
    };
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
