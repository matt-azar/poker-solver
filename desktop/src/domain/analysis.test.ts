import { describe, expect, it } from "vitest";
import { categorySeatView, normalizeBucketWeights } from "./analysis";

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
});
