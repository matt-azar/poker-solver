import { describe, expect, it } from "vitest";
import {
  applyPaintPreservingExact,
  canonicalizeCombo,
  combosForClass,
  exactCellSummary,
  paintClass,
  parseExactComboToken,
  parseExactRange,
  parseRangeText,
  serializeExactRange,
  weightsFromExact,
} from "./range";

describe("exact combo parsing", () => {
  it("parses suit-specific tokens like AsAd:0.5", () => {
    const { range, errors } = parseExactRange("AsAd:0.5,KK");
    expect(errors).toEqual([]);
    expect(range.get("AsAd")).toBeCloseTo(0.5, 12);
    expect(range.get(canonicalizeCombo("As", "Ad"))).toBeCloseTo(0.5, 12);
    for (const combo of combosForClass("KK")!) {
      expect(range.get(combo)).toBe(1);
    }
    expect(range.size).toBe(1 + 6);
  });

  it("accepts spaced exact combos and canonicalizes order", () => {
    expect(parseExactComboToken("AdAs")).toBe("AsAd");
    expect(parseExactComboToken("As Ad")).toBe("AsAd");
    const { range, errors } = parseExactRange("Ad As:0.25");
    expect(errors).toEqual([]);
    expect(range.get("AsAd")).toBeCloseTo(0.25, 12);
  });

  it("reports unsupported tokens instead of silently dropping them", () => {
    const { range, errors } = parseExactRange("AA,ZZ,AKx,AsAd:0.5");
    expect(range.get("AsAd")).toBeCloseTo(0.5, 12);
    // Later exact token overwrites one AA combo; the rest stay at 1.
    expect(
      combosForClass("AA")!
        .filter((combo) => combo !== "AsAd")
        .every((combo) => range.get(combo) === 1),
    ).toBe(true);
    expect(errors.map((error) => error.token)).toEqual(["ZZ", "AKx"]);
    expect(errors.every((error) => /unsupported/i.test(error.message))).toBe(true);
  });

  it("rejects bad exact-combo weights", () => {
    const { errors } = parseExactRange("AsAd:-1,KhKd:nope");
    expect(errors.length).toBe(2);
    expect(errors[0]?.message).toMatch(/nonnegative/i);
  });
});

describe("exact range grid derivation", () => {
  it("averages mixed weights within a 169-cell and flags mixed", () => {
    const { range } = parseExactRange("AsAd:0.5,AhAc:1");
    const summary = exactCellSummary(range, 0, 0);
    expect(summary.comboCount).toBe(6);
    expect(summary.mixed).toBe(true);
    expect(summary.average).toBeCloseTo((0.5 + 1) / 6, 12);
    expect(summary.max).toBe(1);
    expect(summary.min).toBe(0);

    const grid = weightsFromExact(range);
    expect(grid[0]![0]).toBeCloseTo(summary.average, 12);
  });

  it("keeps uniform class weights as full inclusion on the grid", () => {
    const grid = weightsFromExact(parseExactRange("AA:0.5,AKs").range);
    expect(grid[0]![0]).toBeCloseTo(0.5, 12);
    expect(grid[0]![1]).toBeCloseTo(1, 12);
  });
});

describe("paintClass preserves untouched exact combos", () => {
  it("keeps AsAd:0.5,KK after painting QQ", () => {
    const parsed = parseExactRange("AsAd:0.5,KK");
    expect(parsed.errors).toEqual([]);
    const painted = paintClass(parsed.range, "QQ", 1);
    expect(painted.get("AsAd")).toBeCloseTo(0.5, 12);
    for (const combo of combosForClass("KK")!) {
      expect(painted.get(combo)).toBe(1);
    }
    for (const combo of combosForClass("QQ")!) {
      expect(painted.get(combo)).toBe(1);
    }

    const text = serializeExactRange(painted);
    expect(text).toContain("AsAd:0.5");
    expect(text).toMatch(/\bKK\b/);
    expect(text).toMatch(/\bQQ\b/);
    expect(text).not.toMatch(/\bAA\b/);
  });

  it("applyPaintPreservingExact round-trips for studyStore follow-up", () => {
    const result = applyPaintPreservingExact("AsAd:0.5,KK", "QQ", 0.5);
    expect(result.errors).toEqual([]);
    expect(result.text).toContain("AsAd:0.5");
    expect(result.text).toMatch(/\bKK\b/);
    expect(result.text).toContain("QQ:0.5");
    expect(result.range.get("AsAd")).toBeCloseTo(0.5, 12);
    expect(result.grid[2]![2]).toBeCloseTo(0.5, 12); // QQ
  });

  it("clearing a class does not drop unrelated exact combos", () => {
    const painted = paintClass(parseExactRange("AsAd:0.5,KK,QQ").range, "QQ", 0);
    expect(painted.get("AsAd")).toBeCloseTo(0.5, 12);
    expect(combosForClass("QQ")!.every((combo) => !painted.has(combo))).toBe(true);
    expect(serializeExactRange(painted)).toBe("AsAd:0.5,KK");
  });
});

describe("parseRangeText compatibility wrappers", () => {
  it("still expands class tokens onto the 169-grid", () => {
    const grid = parseRangeText("AA,AKs:0.5");
    expect(grid[0]![0]).toBe(1);
    expect(grid[0]![1]).toBeCloseTo(0.5, 12);
  });

  it("averages exact combos into the class cell instead of ignoring them", () => {
    const grid = parseRangeText("AsAd:0.5");
    expect(grid[0]![0]).toBeCloseTo(0.5 / 6, 12);
  });
});
