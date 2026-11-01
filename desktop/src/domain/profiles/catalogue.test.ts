import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseRangeText } from "../range";
import {
  createRangeProfileCatalogue,
  rangesFromSnapshot,
  type ProfileStorage,
} from "./catalogue";
import { parseRangeProfileDocument } from "./parse";
import { RANGE_PROFILES_STORAGE_KEY, type RangeProfile } from "./types";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(
  here,
  "../../../../configs/range-profiles/fixture-co-bb-srp-100bb-2.5x.json",
);

function memoryStorage(initial: Record<string, string> = {}): ProfileStorage {
  const map = new Map<string, string>(Object.entries(initial));
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

describe("createRangeProfileCatalogue", () => {
  const fixture: RangeProfile = parseRangeProfileDocument(
    readFileSync(fixturePath, "utf8"),
  );

  it("lists seed profiles and resolves by id/revision", () => {
    const catalogue = createRangeProfileCatalogue([fixture]);
    expect(catalogue.listProfiles().map((p) => p.id)).toEqual([fixture.id]);
    expect(catalogue.getProfile(fixture.id)?.displayName).toBe(fixture.displayName);
    expect(
      catalogue.getProfileRevision(fixture.id, fixture.dataRevision)?.ranges.ip,
    ).toBe(fixture.ranges.ip);
  });

  it("snapshot for persistence includes id + revision + actual range strings", () => {
    const catalogue = createRangeProfileCatalogue([fixture]);
    const snap = catalogue.snapshotForApply(fixture);
    expect(snap).toEqual({
      profileId: fixture.id,
      dataRevision: fixture.dataRevision,
      ranges: { oop: fixture.ranges.oop, ip: fixture.ranges.ip },
    });
    expect(snap.ranges.oop).toContain("AKo:0.5");
    expect(snap.ranges.ip).toContain("AKo:0.5");

    // Reopen path uses snapshot ranges without needing the live catalogue.
    const applied = rangesFromSnapshot(snap);
    expect(applied.oopRange).toBe(fixture.ranges.oop);
    expect(applied.ipRange).toBe(fixture.ranges.ip);
    expect(applied.profileId).toBe(fixture.id);
    expect(applied.dataRevision).toBe(fixture.dataRevision);

    const oopGrid = parseRangeText(applied.oopRange);
    expect(oopGrid[1][0]).toBeCloseTo(0.5, 8);
  });

  it("getProfileRevision does not silently return a newer revision", () => {
    const older: RangeProfile = {
      ...fixture,
      dataRevision: "1",
      ranges: { oop: "AA", ip: "KK" },
    };
    const newer: RangeProfile = {
      ...fixture,
      dataRevision: "2",
      ranges: { oop: "QQ+", ip: "JJ+" },
    };
    const catalogue = createRangeProfileCatalogue([older, newer]);
    expect(catalogue.getProfile(fixture.id)?.dataRevision).toBe("2");
    expect(catalogue.getProfileRevision(fixture.id, "1")?.ranges.oop).toBe("AA");
    expect(catalogue.getProfileRevision(fixture.id, "2")?.ranges.oop).toBe("QQ+");
    expect(catalogue.getProfileRevision(fixture.id, "9")).toBeUndefined();
  });

  it("persists user imports under holdem-study-range-profiles", () => {
    const storage = memoryStorage();
    const catalogue = createRangeProfileCatalogue([], storage);
    const imported = catalogue.importProfile(JSON.parse(JSON.stringify(fixture)));
    expect(imported.error).toBeUndefined();
    expect(imported.profile?.id).toBe(fixture.id);

    const stored = storage.getItem(RANGE_PROFILES_STORAGE_KEY);
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored!).length).toBe(1);

    const reloaded = createRangeProfileCatalogue([], storage);
    expect(reloaded.getProfile(fixture.id)?.ranges.ip).toBe(fixture.ranges.ip);
  });

  it("importProfile returns error for invalid JSON", () => {
    const catalogue = createRangeProfileCatalogue([]);
    const result = catalogue.importProfile("{not-json");
    expect(result.profile).toBeUndefined();
    expect(result.error).toMatch(/invalid|JSON|must/i);
  });
});
