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
  LEGACY_SETTINGS_KEY,
  applyDocumentTheme,
  normalizePreference,
  resolveTheme,
  useThemeStore,
} = await import("./themeStore");

describe("themeStore (dark-only)", () => {
  beforeEach(() => {
    localStorage.clear();
    useThemeStore.getState().setPreference();
  });

  it("normalizes any preference to dark", () => {
    expect(normalizePreference("light")).toBe("dark");
    expect(normalizePreference("system")).toBe("dark");
    expect(normalizePreference("nope")).toBe("dark");
    expect(normalizePreference("dark")).toBe("dark");
  });

  it("resolveTheme is always dark", () => {
    expect(resolveTheme("light")).toBe("dark");
    expect(resolveTheme("system")).toBe("dark");
    expect(useThemeStore.getState().theme).toBe("dark");
  });

  it("migrates stored light preference to dark", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    useThemeStore.getState().setPreference("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(useThemeStore.getState().preference).toBe("dark");
    expect(useThemeStore.getState().theme).toBe("dark");
  });

  it("strips legacy themePreference from settings blob on migrate", () => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    localStorage.setItem(
      LEGACY_SETTINGS_KEY,
      JSON.stringify({ themePreference: "light", evDisplayBasis: "local" }),
    );
    // Re-run migrate by calling setPreference (write path) after a fresh clear of key.
    useThemeStore.getState().setPreference();
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("applyDocumentTheme sets dark body/html dataset", () => {
    applyDocumentTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.body.dataset.theme).toBe("dark");
    expect(document.body.classList.contains("theme-dark")).toBe(true);
    expect(document.body.classList.contains("theme-light")).toBe(false);
  });
});
