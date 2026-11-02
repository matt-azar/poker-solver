import { beforeEach, describe, expect, it } from "vitest";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: query.includes("dark"),
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  }),
});

const {
  THEME_STORAGE_KEY,
  applyDocumentTheme,
  normalizePreference,
  resolveTheme,
  useThemeStore,
} = await import("./themeStore");

describe("themeStore (R15)", () => {
  beforeEach(() => {
    localStorage.clear();
    useThemeStore.getState().setPreference("system");
  });

  it("normalizes unknown values to system", () => {
    expect(normalizePreference("nope")).toBe("system");
    expect(normalizePreference("dark")).toBe("dark");
  });

  it("resolves system without wiping the preference", () => {
    useThemeStore.getState().setPreference("system");
    expect(useThemeStore.getState().preference).toBe("system");
    expect(resolveTheme("system")).toBe(useThemeStore.getState().theme);
    // Preference stays system even though display is concrete.
    expect(useThemeStore.getState().preference).toBe("system");
  });

  it("persists preference so Theme and Settings share one authority", () => {
    useThemeStore.getState().setPreference("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(useThemeStore.getState().theme).toBe("dark");

    useThemeStore.getState().setPreference("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(useThemeStore.getState().theme).toBe("light");
  });

  it("toggleTheme writes an explicit light/dark preference", () => {
    useThemeStore.getState().setPreference("system");
    useThemeStore.getState().toggleTheme();
    const after = useThemeStore.getState();
    expect(after.preference === "light" || after.preference === "dark").toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(after.preference);
  });

  it("applyDocumentTheme sets body/html dataset", () => {
    applyDocumentTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.body.dataset.theme).toBe("dark");
    expect(document.body.classList.contains("theme-dark")).toBe(true);
  });
});
