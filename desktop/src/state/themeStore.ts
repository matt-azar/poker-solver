import { create } from "zustand";
import type { ThemePreference } from "../domain/types";

export const THEME_STORAGE_KEY = "study-theme-preference";
/** Legacy key used before themeStore owned preference; migrate once. */
export const LEGACY_SETTINGS_KEY = "study-ui-settings-v1";

function systemTheme(): "light" | "dark" {
  if (typeof window === "undefined" || !window.matchMedia) {
    return "light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function normalizePreference(value: string | null | undefined): ThemePreference {
  if (value === "dark" || value === "light" || value === "system") {
    return value;
  }
  return "system";
}

export function resolveTheme(preference: ThemePreference): "light" | "dark" {
  return preference === "system" ? systemTheme() : preference;
}

export function applyDocumentTheme(theme: "light" | "dark") {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.dataset.theme = theme;
  document.body.dataset.theme = theme;
  document.body.classList.remove("theme-light", "theme-dark");
  document.body.classList.add(`theme-${theme}`);
}

interface ThemeState {
  preference: ThemePreference;
  theme: "light" | "dark";
  setPreference: (preference: ThemePreference) => void;
  toggleTheme: () => void;
}

function readLegacySettingsPreference(): ThemePreference | null {
  try {
    const raw = localStorage.getItem(LEGACY_SETTINGS_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { themePreference?: string };
    if (
      parsed.themePreference === "dark" ||
      parsed.themePreference === "light" ||
      parsed.themePreference === "system"
    ) {
      return parsed.themePreference;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function readStoredPreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw !== null) {
      return normalizePreference(raw);
    }
    // One-shot migration from the old settings blob.
    const legacy = readLegacySettingsPreference();
    if (legacy) {
      writeStoredPreference(legacy);
      return legacy;
    }
  } catch {
    /* ignore */
  }
  return "system";
}

function writeStoredPreference(preference: ThemePreference) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    /* ignore quota */
  }
}

const initialPreference =
  typeof localStorage === "undefined" ? "system" : readStoredPreference();
const initialTheme = resolveTheme(initialPreference);

export const useThemeStore = create<ThemeState>((set, get) => ({
  preference: initialPreference,
  theme: initialTheme,
  setPreference(preference) {
    const next = normalizePreference(preference);
    writeStoredPreference(next);
    const theme = resolveTheme(next);
    applyDocumentTheme(theme);
    set({ preference: next, theme });
  },
  toggleTheme() {
    const current = get().theme;
    // Toggle display theme only; does not treat System as wiped until user picks light/dark.
    get().setPreference(current === "dark" ? "light" : "dark");
  },
}));

if (typeof window !== "undefined") {
  applyDocumentTheme(initialTheme);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    const preference = useThemeStore.getState().preference;
    if (preference === "system") {
      const theme = resolveTheme("system");
      applyDocumentTheme(theme);
      useThemeStore.setState({ theme });
    }
  });
}
