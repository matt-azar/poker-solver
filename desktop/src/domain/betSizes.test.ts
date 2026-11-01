import { describe, expect, it } from "vitest";
import {
  formatActionDisplay,
  geometricPotFraction,
  mergeSizeFractions,
  parseSizeTokenDetailed,
  resolveSizeList,
} from "./betSizes";

describe("betSizes", () => {
  it("parses Pio percent sizes and explicit fractions", () => {
    expect(parseSizeTokenDetailed("75")?.fraction).toBeCloseTo(0.75, 12);
    expect(parseSizeTokenDetailed("150")?.fraction).toBeCloseTo(1.5, 12);
    expect(parseSizeTokenDetailed("100")?.fraction).toBeCloseTo(1, 12);
    expect(parseSizeTokenDetailed("0.5")?.fraction).toBeCloseTo(0.5, 12);
    expect(parseSizeTokenDetailed("75%")?.fraction).toBeCloseTo(0.75, 12);
  });

  it("parses geometric e tokens", () => {
    expect(parseSizeTokenDetailed("e")).toEqual({
      fraction: 0,
      geometric: true,
      geometricMultiple: 1,
    });
    expect(parseSizeTokenDetailed("3e")?.geometricMultiple).toBe(3);
  });

  it("matches engine geometric_pot_fraction pins", () => {
    const flop = geometricPotFraction(100, 300, 3);
    expect(flop).toBeCloseTo((Math.pow(7, 1 / 3) - 1) / 2, 12);
  });

  it("expands e when geometric flag is off", () => {
    const geo = geometricPotFraction(100, 300, 3);
    const sizes = resolveSizeList("33, e, 2e", {
      pot: 100,
      stack: 300,
      boardLen: 3,
      geometricFlag: false,
    });
    expect(sizes[0]).toBeCloseTo(0.33, 12);
    expect(sizes.some((size) => Math.abs(size - geo) < 1e-10)).toBe(true);
    expect(sizes.some((size) => Math.abs(size - geo * 2) < 1e-10)).toBe(true);
  });

  it("merges near chip sizes within a threshold", () => {
    // pot 100: 0.74 → 74, 0.76 → 76 → within 10%
    expect(mergeSizeFractions([0.74, 0.76], 100, 10)).toEqual([0.76]);
  });

  it("formats Study action display as pot tag + chips", () => {
    expect(formatActionDisplay("Bet 75", 100, "both")).toEqual({
      primary: "b75",
      secondary: "75.0",
    });
    expect(formatActionDisplay("Check", 100, "both")).toEqual({
      primary: "Check",
      secondary: null,
    });
  });
});
