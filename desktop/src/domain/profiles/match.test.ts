import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { matchRangeProfiles } from "./match";
import { parseRangeProfileDocument, wrapLegacyPreset } from "./parse";
import type { RangeProfile, RangeProfileQuery } from "./types";

const here = dirname(fileURLToPath(import.meta.url));
const profilesDir = join(here, "../../../../configs/range-profiles");

function loadFixture(name: string): RangeProfile {
  return parseRangeProfileDocument(
    readFileSync(join(profilesDir, name), "utf8"),
  );
}

const srp25: RangeProfileQuery = {
  positions: { oop: "BB", ip: "CO" },
  format: "cash_6max",
  stackBb: 100,
  openSizeBb: 2.5,
  preflopActions: [
    { position: "UTG", kind: "fold" },
    { position: "HJ", kind: "fold" },
    { position: "CO", kind: "open", sizeBb: 2.5 },
    { position: "BTN", kind: "fold" },
    { position: "SB", kind: "fold" },
    { position: "BB", kind: "call", sizeBb: 1.5 },
  ],
};

describe("matchRangeProfiles", () => {
  const fixture25 = loadFixture("fixture-co-bb-srp-100bb-2.5x.json");
  const fixture3x = loadFixture("fixture-co-bb-srp-100bb-3x.json");
  const legacy = wrapLegacyPreset({
    id: "broadway",
    name: "Broadway",
    text: "TT+,ATs+,KTs+,QTs+,JTs,AJo+,KQo",
  });
  const catalogue = [fixture25, fixture3x, legacy];

  it("exact-matches CO vs BB SRP 100bb 2.5x fixture", () => {
    const result = matchRangeProfiles(srp25, catalogue);
    expect(result.exact.map((p) => p.id)).toEqual(["fixture-co-bb-srp-100bb-2.5x"]);
    expect(result.none).toBeUndefined();
    // 3x open is an alternative, not exact
    expect(result.alternatives.some((a) => a.profile.id === fixture3x.id)).toBe(true);
    const alt3 = result.alternatives.find((a) => a.profile.id === fixture3x.id)!;
    expect(alt3.differences.some((d) => /open size/i.test(d))).toBe(true);
  });

  it("different open size → alternative or conflict, not silent exact", () => {
    const result = matchRangeProfiles(
      { ...srp25, openSizeBb: 3, preflopActions: fixture3x.preflopActions },
      catalogue,
    );
    expect(result.exact.map((p) => p.id)).toEqual(["fixture-co-bb-srp-100bb-3x"]);
    expect(result.exact.map((p) => p.id)).not.toContain(fixture25.id);
    const alt25 = result.alternatives.find((a) => a.profile.id === fixture25.id);
    expect(alt25).toBeDefined();
    expect(alt25!.differences.some((d) => /open size/i.test(d))).toBe(true);
  });

  it("different stack → not exact", () => {
    const result = matchRangeProfiles({ ...srp25, stackBb: 150 }, catalogue);
    expect(result.exact).toEqual([]);
    const near = result.alternatives.find((a) => a.profile.id === fixture25.id);
    expect(near).toBeDefined();
    expect(near!.differences.some((d) => /stack/i.test(d))).toBe(true);
  });

  it("legacy incomplete preset is never in exact", () => {
    const result = matchRangeProfiles(srp25, catalogue);
    expect(result.exact.every((p) => !p.legacyPreset)).toBe(true);
    expect(result.exact.map((p) => p.id)).not.toContain(legacy.id);

    // Even a query that only shares stakes-like nothing — query against legacy alone
    const legacyOnly = matchRangeProfiles(
      { positions: { oop: "BB", ip: "CO" }, stackBb: 100, openSizeBb: 2.5 },
      [legacy],
    );
    expect(legacyOnly.exact).toEqual([]);
  });

  it('rake/stakes label "100NL" alone does not exact-match', () => {
    const result = matchRangeProfiles({ stakesLabel: "100NL" }, catalogue);
    expect(result.exact).toEqual([]);
    // May surface as alternatives via shared stakes, with incomplete-constraint note
    expect(
      result.alternatives.length === 0 ||
        result.alternatives.every((a) => a.differences.length > 0),
    ).toBe(true);
  });

  it("cEV + positions + stack + open exact-matches the cEV fixture", () => {
    const result = matchRangeProfiles(
      {
        stakesLabel: "cEV",
        potType: "SRP",
        positions: { oop: "BB", ip: "CO" },
        stackBb: 100,
        openSizeBb: 2.5,
        format: "cash_6max",
      },
      catalogue,
    );
    expect(result.exact.map((p) => p.id)).toEqual([
      "fixture-co-bb-srp-100bb-2.5x",
    ]);
  });

  it("stakes + mismatched stack still not exact even when stakes agree", () => {
    const result = matchRangeProfiles(
      {
        stakesLabel: "cEV",
        positions: { oop: "BB", ip: "CO" },
        stackBb: 40,
        openSizeBb: 2.5,
        format: "cash_6max",
      },
      catalogue,
    );
    expect(result.exact).toEqual([]);
  });

  it("returns none reason when catalogue is empty for the query", () => {
    const result = matchRangeProfiles(srp25, []);
    expect(result.exact).toEqual([]);
    expect(result.alternatives).toEqual([]);
    expect(result.none).toMatch(/no range profiles matched/i);
  });
});
