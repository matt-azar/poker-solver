import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseRangeText } from "../range";
import {
  parseRangeProfile,
  parseRangeProfileDocument,
  tryParseRangeProfile,
  wrapLegacyPreset,
} from "./parse";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(
  here,
  "../../../../configs/range-profiles/fixture-co-bb-srp-100bb-2.5x.json",
);

describe("parseRangeProfile", () => {
  it("parses the synthetic CO vs BB 2.5x fixture document", () => {
    const raw = readFileSync(fixturePath, "utf8");
    const profile = parseRangeProfileDocument(raw);
    expect(profile.id).toBe("fixture-co-bb-srp-100bb-2.5x");
    expect(profile.schemaVersion).toBe(1);
    expect(profile.positions).toEqual({ oop: "BB", ip: "CO" });
    expect(profile.startingStackBb).toBe(100);
    expect(profile.provenance.classification).toBe("synthetic_fixture");
    expect(profile.rake.known).toBe(true);
    expect(profile.labels?.stakes).toBe("cEV");
    expect(profile.rake.collection).toBe("none");
    expect(profile.legacyPreset).toBeUndefined();
  });

  it("preserves mixed-weight range text through parse round-trip", () => {
    const raw = readFileSync(fixturePath, "utf8");
    const profile = parseRangeProfileDocument(raw);
    expect(profile.ranges.ip).toMatch(/AKo/);
    expect(profile.ranges.oop).toMatch(/AKo/);
    expect(profile.ranges.oop).not.toEqual(profile.ranges.ip);

    const reparsed = parseRangeProfile(JSON.parse(JSON.stringify(profile)));
    expect(reparsed.ranges.oop).toBe(profile.ranges.oop);
    expect(reparsed.ranges.ip).toBe(profile.ranges.ip);

    const oopGrid = parseRangeText(profile.ranges.oop);
    const ipGrid = parseRangeText(profile.ranges.ip);
    // AKo is offsuit → lower triangle (row > col) for A=0, K=1 → grid[1][0]
    expect(oopGrid[1][0]).toBeCloseTo(0.35, 8);
    // IP open shape lists AKo at full weight in the revised fixture.
    expect(ipGrid[1][0]).toBeCloseTo(1, 8);
  });

  it("rejects missing required fields", () => {
    const result = tryParseRangeProfile({ id: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/schemaVersion|must/i);
    }
  });

  it("keeps synthetic_fixture classification (no fabricated completeness)", () => {
    const profile = parseRangeProfileDocument(readFileSync(fixturePath, "utf8"));
    expect(profile.provenance.classification).toBe("synthetic_fixture");
    expect(profile.provenance.notes).toMatch(/NOT verified GTO|not study|Import a reliable pack/i);
  });
});

describe("wrapLegacyPreset", () => {
  it("marks incomplete assumptions and legacyPreset", () => {
    const wrapped = wrapLegacyPreset({
      id: "value-heavy",
      name: "Value heavy",
      text: "QQ+,AKs:1,AKo:0.5",
    });
    expect(wrapped.legacyPreset).toBe(true);
    expect(wrapped.format).toBe("unknown");
    expect(wrapped.provenance.classification).toBe("unknown");
    expect(wrapped.ranges.oop).toBe("QQ+,AKs:1,AKo:0.5");
    expect(wrapped.id).toBe("legacy:value-heavy");
  });
});
