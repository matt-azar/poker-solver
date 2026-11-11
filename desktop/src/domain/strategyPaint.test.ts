import { describe, expect, it } from "vitest";
import { mapActionColors } from "./actionColors";
import {
  STRATEGY_PAINT_MIN_WEIGHT,
  buildStrategyPaintSegments,
} from "./strategyPaint";

describe("buildStrategyPaintSegments", () => {
  it("orders passive left and sizes by mix weight", () => {
    const actions = ["Check", "Bet 50", "Bet 100"];
    const colors = mapActionColors(actions);
    const segments = buildStrategyPaintSegments(
      actions,
      [0.25, 0.5, 0.25],
      colors.byIndex,
    );
    expect(segments.map((s) => s.label)).toEqual([
      "Check",
      "Bet 50",
      "Bet 100",
    ]);
    expect(segments.map((s) => s.weight)).toEqual([0.25, 0.5, 0.25]);
    expect(segments[0]?.color).toBe(colors.byIndex[0]);
    expect(segments[2]?.color).toBe(colors.byIndex[2]);
  });

  it("drops near-zero weights with the shared cutoff", () => {
    const actions = ["Check", "Bet 50"];
    const colors = mapActionColors(actions);
    const segments = buildStrategyPaintSegments(
      actions,
      [1, STRATEGY_PAINT_MIN_WEIGHT / 2],
      colors.byIndex,
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]?.label).toBe("Check");
  });

  it("returns [] for missing mix", () => {
    expect(buildStrategyPaintSegments(["Check"], null, ["#0f0"])).toEqual([]);
    expect(buildStrategyPaintSegments([], [1], [])).toEqual([]);
  });
});
