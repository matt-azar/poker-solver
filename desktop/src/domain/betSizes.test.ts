import { describe, expect, it } from "vitest";
import {
  formatActionDisplay,
  formatActionTooltip,
  formatFrequencyPct,
  geometricPotFraction,
  mergeSizeFractions,
  parseSizeTokenDetailed,
  potTagFromLabel,
  encodeBetList,
  encodeRaiseList,
  EXPLICIT_EMPTY_SPEC,
  GEO_BASE,
  resolveRaiseSizeList,
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
    expect(parseSizeTokenDetailed("e")).toMatchObject({
      fraction: 0,
      geometric: true,
      geometricMultiple: 1,
      raiseMultiple: false,
    });
    expect(parseSizeTokenDetailed("3e")?.geometricMultiple).toBe(3);
  });

  it("parses raise multiples and keeps pot raises separate from bets", () => {
    expect(parseSizeTokenDetailed("2x")).toMatchObject({
      raiseMultiple: true,
      raiseMultipleValue: 2,
    });
    expect(parseSizeTokenDetailed("2.5x")?.raiseMultipleValue).toBe(2.5);
    expect(resolveSizeList("50, 2x", {
      pot: 100,
      stack: 200,
      boardLen: 5,
      geometricFlag: false,
    })).toEqual([0.5]);
    expect(
      resolveRaiseSizeList("50, 2x, 2.5x", {
        pot: 100,
        stack: 200,
        boardLen: 5,
        geometricFlag: false,
      }),
    ).toEqual({ fractions: [0.5], multiples: [2, 2.5] });
    expect(
      resolveRaiseSizeList("", {
        pot: 100,
        stack: 200,
        boardLen: 5,
        geometricFlag: false,
      }),
    ).toEqual({ fractions: [], multiples: [] });
  });

  it("matches engine geometric_pot_fraction pins", () => {
    const flop = geometricPotFraction(100, 300, 3);
    expect(flop).toBeCloseTo((Math.pow(7, 1 / 3) - 1) / 2, 12);
  });

  it("keeps e and 2e as node-expanded sentinels", () => {
    expect(encodeBetList("", false)).toEqual([EXPLICIT_EMPTY_SPEC]);
    expect(encodeBetList("33, e, 2e", false)).toEqual([0.33, GEO_BASE, GEO_BASE - 2]);
    expect(encodeBetList("50", true)).toEqual([0.5, GEO_BASE]);
    expect(encodeBetList("", true)).toEqual([EXPLICIT_EMPTY_SPEC]);
    expect(encodeRaiseList("", [0.5], false)).toEqual([0.5]);
    expect(encodeRaiseList("-", [0.5], false)).toEqual([EXPLICIT_EMPTY_SPEC]);
    expect(encodeRaiseList("2.5x", [0.5], false)[0]).toBeCloseTo(-3e9 - 2.5, 6);
  });

  it("merges near chip sizes within a threshold", () => {
    // pot 100: 0.74 → 74, 0.76 → 76 → within 10%
    expect(mergeSizeFractions([0.74, 0.76], 100, 10)).toEqual([0.76]);
  });

  it("keeps a 50% pot bet as compact b50 (not Bet 50%)", () => {
    expect(potTagFromLabel("Bet 50", 100)).toBe("b50");
    const both = formatActionDisplay("Bet 50", 100, "both");
    expect(both.primary).toBe("b50");
    expect(both.secondary).toBe("50.0 chips");
    expect(both.potTag).toBe("b50");
    expect(both.primary).not.toMatch(/%/);
    expect(both.primary).not.toBe("Bet 50%");
    expect(both.primary).not.toBe("50%");

    const potOnly = formatActionDisplay("Bet 50", 100, "pot");
    expect(potOnly.primary).toBe("b50");
    expect(potOnly.secondary).toBeNull();

    const chipsOnly = formatActionDisplay("Bet 50", 100, "chips");
    expect(chipsOnly.primary).toBe("50.0 chips");
    expect(chipsOnly.potTag).toBe("b50");
  });

  it("formats Study action display as pot tag + chips with units", () => {
    expect(formatActionDisplay("Bet 75", 100, "both")).toEqual({
      primary: "b75",
      secondary: "75.0 chips",
      raw: "Bet 75",
      potTag: "b75",
    });
    expect(formatActionDisplay("Check", 100, "both")).toEqual({
      primary: "Check",
      secondary: null,
      raw: "Check",
      potTag: null,
    });
    expect(formatActionDisplay("Raise 100", 100, "both").primary).toBe("r100");
  });

  it("keeps frequency formatting separate from pot tags", () => {
    expect(formatFrequencyPct(0.319)).toBe("31.9%");
    expect(formatFrequencyPct(0.5)).toBe("50.0%");
    expect(formatFrequencyPct(null)).toBeNull();
    // b50 must never be confused with a 50% frequency string
    expect(formatActionDisplay("Bet 50", 100, "both").primary).not.toBe(
      formatFrequencyPct(0.5),
    );
  });

  it("builds tooltips with size tag, chips, and raw label", () => {
    expect(formatActionTooltip("Bet 50", 100, "both")).toBe(
      "b50 · 50.0 chips · Bet 50",
    );
    expect(formatActionTooltip("Bet 50", 100, "pot")).toContain("b50");
    expect(formatActionTooltip("Bet 50", 100, "pot")).toContain("50.0 chips");
  });
});
