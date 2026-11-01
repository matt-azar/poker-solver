import { describe, expect, it } from "vitest";
import {
  categorySeatView,
  filterHandsByEquityBands,
  filteredEquityComposition,
  groupRangesByFolder,
  handShape,
  normalizeBucketWeights,
} from "./analysis";

describe("analysis helpers", () => {
  it("normalizes equity bucket weights to fractions", () => {
    const rows = normalizeBucketWeights([
      { lo: 0, hi: 0.1, weight: 1 },
      { lo: 0.1, hi: 0.2, weight: 3 },
    ]);
    expect(rows[0]?.fraction).toBeCloseTo(0.25, 12);
    expect(rows[1]?.fraction).toBeCloseTo(0.75, 12);
  });

  it("maps parallel category arrays from explorer", () => {
    const view = categorySeatView(["pair", "flush"], {
      defined: true,
      total_mass: 4,
      fractions: [0.25, 0.75],
      mass: [1, 3],
    });
    expect(view.rows).toEqual([
      { name: "pair", fraction: 0.25, mass: 1 },
      { name: "flush", fraction: 0.75, mass: 3 },
    ]);
  });

  it("classifies combo shapes", () => {
    expect(handShape("AhAd")).toBe("pair");
    expect(handShape("AhKh")).toBe("suited");
    expect(handShape("AhKd")).toBe("offsuit");
    expect(handShape("AKs")).toBe("suited");
    expect(handShape("AKo")).toBe("offsuit");
    expect(handShape("AA")).toBe("pair");
  });

  it("filters hands by selected equity bands", () => {
    const hands = [
      { combo: "AhAd", equity: 0.85, weight: 1 },
      { combo: "2c3d", equity: 0.12, weight: 2 },
      { combo: "KcKd", equity: 0.91, weight: 1 },
    ];
    const filtered = filterHandsByEquityBands(hands, [{ lo: 0.8, hi: 0.9 }, { lo: 0.9, hi: 1 }]);
    expect(filtered.map((row) => row.combo)).toEqual(["AhAd", "KcKd"]);
  });

  it("composes filtered check-down equity by shape", () => {
    const view = filteredEquityComposition([
      { combo: "AhAd", equity: 0.8, weight: 1 },
      { combo: "AhKh", equity: 0.6, weight: 1 },
      { combo: "AhKd", equity: 0.4, weight: 2 },
    ]);
    expect(view.totalWeight).toBe(4);
    expect(view.averageEquity).toBeCloseTo((0.8 + 0.6 + 0.8) / 4, 12);
    expect(view.shapes.find((row) => row.name === "pair")?.fraction).toBeCloseTo(0.25, 12);
    expect(view.shapes.find((row) => row.name === "suited")?.fraction).toBeCloseTo(0.25, 12);
    expect(view.shapes.find((row) => row.name === "offsuit")?.fraction).toBeCloseTo(0.5, 12);
  });

  it("groups nested range presets by folder", () => {
    const groups = groupRangesByFolder([
      { id: "broadway", name: "broadway", folder: "" },
      { id: "open/utg-open", name: "utg open", folder: "open" },
      { id: "open/jj-plus", name: "jj plus", folder: "open" },
      { id: "defend/btn-call", name: "btn call", folder: "defend" },
    ]);
    expect(groups.map((group) => group.folder)).toEqual(["", "defend", "open"]);
    expect(groups[2]?.entries.map((entry) => entry.id)).toEqual([
      "open/jj-plus",
      "open/utg-open",
    ]);
  });
});
