import { describe, expect, it } from "vitest";
import {
  STUDY_SETUP_PREFS_KEY,
  loadStudySetupPreferences,
  normalizeStudySetupPreferences,
  saveStudySetupPreferences,
  type StorageAdapter,
} from "./preferences";

function memoryStorage(initial: Record<string, string> = {}): StorageAdapter {
  const map = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return map.has(key) ? map.get(key)! : null;
    },
    setItem(key, value) {
      map.set(key, value);
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

describe("StudySetupPreferences", () => {
  it("round-trips through a storage adapter", () => {
    const storage = memoryStorage();
    saveStudySetupPreferences(
      {
        defaultProfileId: "co-bb-srp",
        defaultStackBb: 100,
        defaultOpenSizeBb: 2.5,
        defaultTreeBets: { oopBets: "0.33,0.75", ipBets: "0.33,0.75" },
      },
      storage,
    );
    const loaded = loadStudySetupPreferences(storage);
    expect(loaded.defaultProfileId).toBe("co-bb-srp");
    expect(loaded.defaultStackBb).toBe(100);
    expect(loaded.defaultOpenSizeBb).toBe(2.5);
    expect(loaded.defaultTreeBets?.ipBets).toBe("0.33,0.75");
    expect(storage.getItem(STUDY_SETUP_PREFS_KEY)).toContain("co-bb-srp");
  });

  it("ignores invalid payloads", () => {
    expect(normalizeStudySetupPreferences(null)).toEqual({});
    expect(
      normalizeStudySetupPreferences({ defaultStackBb: "100NL" }),
    ).toEqual({});
    expect(
      normalizeStudySetupPreferences({ defaultStackBb: -5 }),
    ).toEqual({});
  });
});
