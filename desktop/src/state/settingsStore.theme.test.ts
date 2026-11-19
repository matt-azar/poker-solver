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

const { useSettingsStore, DEFAULT_UI_SETTINGS } = await import("./settingsStore");

describe("settingsStore (no theme preference)", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({
      settings: { ...DEFAULT_UI_SETTINGS },
      settingsOpen: false,
    });
  });

  it("persists display settings without themePreference", () => {
    useSettingsStore.getState().updateSettings({ evDisplayBasis: "root_centered" });
    expect(useSettingsStore.getState().settings.evDisplayBasis).toBe("root_centered");
    const raw = localStorage.getItem("study-ui-settings-v1");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.themePreference).toBeUndefined();
    expect(parsed.evDisplayBasis).toBe("root_centered");
    expect(Object.keys(useSettingsStore.getState().settings)).not.toContain("themePreference");
  });

  it("resetSettings restores display defaults only", () => {
    useSettingsStore.getState().updateSettings({
      evDisplayBasis: "root_centered",
      betSizeDisplay: "chips",
    });
    useSettingsStore.getState().resetSettings();
    expect(useSettingsStore.getState().settings).toEqual(DEFAULT_UI_SETTINGS);
  });
});
