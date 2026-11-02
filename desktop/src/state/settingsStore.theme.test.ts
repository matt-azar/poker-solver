import { beforeEach, describe, expect, it } from "vitest";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
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

const { THEME_STORAGE_KEY, useThemeStore } = await import("./themeStore");
const { useSettingsStore } = await import("./settingsStore");

describe("settingsStore theme mirror (R15)", () => {
  beforeEach(() => {
    localStorage.clear();
    useThemeStore.getState().setPreference("system");
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        themePreference: "system",
      },
    });
  });

  it("updateSettings themePreference writes themeStore and survives reload key", () => {
    useSettingsStore.getState().updateSettings({ themePreference: "dark" });
    expect(useThemeStore.getState().preference).toBe("dark");
    expect(useSettingsStore.getState().settings.themePreference).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    // Non-theme settings blob must not be the theme authority.
    const raw = localStorage.getItem("study-ui-settings-v1");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).themePreference).toBeUndefined();
  });

  it("Theme button (themeStore) keeps Settings select in sync", () => {
    useThemeStore.getState().setPreference("light");
    expect(useSettingsStore.getState().settings.themePreference).toBe("light");
  });

  it("resetSettings restores system via themeStore", () => {
    useThemeStore.getState().setPreference("dark");
    useSettingsStore.getState().resetSettings();
    expect(useThemeStore.getState().preference).toBe("system");
    expect(useSettingsStore.getState().settings.themePreference).toBe("system");
  });
});
