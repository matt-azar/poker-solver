import { create } from "zustand";
import type { ThemePreference } from "../domain/types";

export const THEME_STORAGE_KEY = "study-theme-preference";

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

function readStoredPreference(): ThemePreference {
  try {
    return normalizePreference(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

function writeStoredPreference(preference: ThemePreference) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    /* ignore quota */
  }
}

const initialPreference = typeof localStorage === "undefined" ? "system" : readStoredPreference();
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
