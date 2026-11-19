import { create } from "zustand";

export const THEME_STORAGE_KEY = "study-theme-preference";
/** Legacy key used before themeStore owned preference; migrate once. */
export const LEGACY_SETTINGS_KEY = "study-ui-settings-v1";

export type AppTheme = "dark";

/** Study chrome is dark-only; any prior light/system preference maps to dark. */
export function normalizePreference(_value?: string | null): AppTheme {
  return "dark";
}

export function resolveTheme(_preference?: string | null): AppTheme {
  return "dark";
}

export function applyDocumentTheme(theme: AppTheme = "dark") {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.dataset.theme = theme;
  document.body.dataset.theme = theme;
  document.body.classList.remove("theme-light", "theme-dark");
  document.body.classList.add(`theme-${theme}`);
}

interface ThemeState {
  /** Always dark; kept for callers that still read preference/theme. */
  preference: AppTheme;
  theme: AppTheme;
  /** No-op setter that re-asserts dark (migrates storage). */
  setPreference: (_preference?: string | null) => void;
}

function writeStoredPreference() {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
  } catch {
    /* ignore quota */
  }
}

/** Drop legacy light/system values so reloads cannot revive a light path. */
function migratePersistedTheme() {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw !== null && raw !== "dark") {
      writeStoredPreference();
    } else if (raw === null) {
      // One-shot: clear any themePreference left in the settings blob.
      const legacy = localStorage.getItem(LEGACY_SETTINGS_KEY);
      if (legacy) {
        try {
          const parsed = JSON.parse(legacy) as { themePreference?: string };
          if (parsed.themePreference !== undefined) {
            const { themePreference: _drop, ...rest } = parsed;
            localStorage.setItem(LEGACY_SETTINGS_KEY, JSON.stringify(rest));
          }
        } catch {
          /* ignore */
        }
      }
      writeStoredPreference();
    }
  } catch {
    /* ignore */
  }
}

if (typeof localStorage !== "undefined") {
  migratePersistedTheme();
}

export const useThemeStore = create<ThemeState>((set) => ({
  preference: "dark",
  theme: "dark",
  setPreference() {
    writeStoredPreference();
    applyDocumentTheme("dark");
    set({ preference: "dark", theme: "dark" });
  },
}));

if (typeof window !== "undefined") {
  applyDocumentTheme("dark");
}
