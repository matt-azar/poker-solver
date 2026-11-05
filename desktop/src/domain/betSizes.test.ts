import { describe, expect, it } from "vitest";
import {
  encodeBetList,
  encodeBettingJob,
  encodeRaiseList,
  EXPLICIT_EMPTY_SPEC,
  formatActionDisplay,
  formatActionTooltip,
  formatDonkField,
  formatEngineSpec,
  formatFrequencyPct,
  formatStreetBetField,
  formatStreetRaiseField,
  formatStoredSizes,
  GEO_BASE,
  geometricPotFraction,
  mergeSizeFractions,
  parseSizeListStrict,
  parseSizeTokenDetailed,
  potTagFromLabel,
  validateBettingLists,
} from "./betSizes";

describe("betSizes", () => {
  it("parses Pio percent sizes and explicit fractions", () => {
    expect(parseSizeTokenDetailed("75")?.fraction).toBeCloseTo(0.75, 12);
    expect(parseSizeTokenDetailed("150")?.fraction).toBeCloseTo(1.5, 12);
    expect(parseSizeTokenDetailed("100")?.fraction).toBeCloseTo(1, 12);
    expect(parseSizeTokenDetailed("0.5")?.fraction).toBeCloseTo(0.5, 12);
    expect(parseSizeTokenDetailed("75%")?.fraction).toBeCloseTo(0.75, 12);
    expect(parseSizeTokenDetailed("0.5%")?.fraction).toBeCloseTo(0.005, 12);
  });

  it("parses geometric e tokens as street counts, not multiples of e", () => {
    expect(parseSizeTokenDetailed("e")).toMatchObject({
      fraction: 0,
      geometric: true,
      geometricStreets: 0,
      raiseMultiple: false,
    });
    expect(parseSizeTokenDetailed("2e")?.geometricStreets).toBe(2);
    expect(parseSizeTokenDetailed("3e")?.geometricStreets).toBe(3);
  });

  it("parses raise multiples", () => {
    expect(parseSizeTokenDetailed("2x")).toMatchObject({
      raiseMultiple: true,
      raiseMultipleValue: 2,
    });
    expect(parseSizeTokenDetailed("2.5x")?.raiseMultipleValue).toBe(2.5);
  });

  it("matches engine geometric_pot_fraction pins", () => {
    const flop = geometricPotFraction(100, 300, 3);
    expect(flop).toBeCloseTo((Math.pow(7, 1 / 3) - 1) / 2, 12);
  });

  it("keeps e and 2e as node-expanded sentinels", () => {
    expect(encodeBetList("")).toEqual([EXPLICIT_EMPTY_SPEC]);
    expect(encodeBetList("33, e, 2e")).toEqual([0.33, GEO_BASE, GEO_BASE - 2]);
    expect(encodeBetList("50")).toEqual([0.5]);
    expect(encodeBetList("50, a")).toEqual([0.5, -1e9]);
    expect(encodeRaiseList("", [0.5])).toEqual([EXPLICIT_EMPTY_SPEC]);
    expect(encodeRaiseList("-", [0.5])).toEqual([EXPLICIT_EMPTY_SPEC]);
    expect(encodeRaiseList("2.5x", [0.5])[0]).toBeCloseTo(-3e9 - 2.5, 6);
  });

  it("round-trips stored sizes through Build text", () => {
    const original = [0.5, 1, 1.5, -20];
    const text = formatStoredSizes(original);
    expect(text).toBe("50, 100, 150, 20c");
    expect(encodeBetList(text)).toEqual(original);
  });

  it("formats small pot fractions with an explicit percent suffix", () => {
    expect(formatEngineSpec(0.005)).toBe("0.5%");
    expect(encodeBetList("0.5%")).toEqual([0.005]);
    expect(encodeBetList(formatEngineSpec(0.005))).toEqual([0.005]);
    expect(formatEngineSpec(0.5)).toBe("50");
    expect(formatEngineSpec(1.5)).toBe("150");
    expect(formatEngineSpec(2.5)).toBe("250");
    expect(encodeBetList(formatEngineSpec(2.5))).toEqual([2.5]);
  });

  it("round-trips overbets, chips, and special tokens", () => {
    const cases: Array<{ specs: number[]; text: string }> = [
      { specs: [0.005], text: "0.5%" },
      { specs: [0.5, 1, 2], text: "50, 100, 200" },
      { specs: [-20], text: "20c" },
      { specs: [GEO_BASE, GEO_BASE - 2, -1e9], text: "e, 2e, a" },
      { specs: [-3e9 - 2.5], text: "2.5x" },
    ];
    for (const entry of cases) {
      expect(formatStoredSizes(entry.specs, { raise: true })).toBe(entry.text);
      if (entry.specs[0] <= -3e9) {
        expect(encodeRaiseList(entry.text, [])).toEqual(entry.specs);
      } else {
        expect(encodeBetList(entry.text)).toEqual(entry.specs);
      }
    }
  });

  it("resolves inherited street bets into Build text", () => {
    expect(formatStreetBetField([], [0.5, 1])).toBe("50, 100");
    expect(formatStreetBetField([EXPLICIT_EMPTY_SPEC], [0.5, 1])).toBe("");
    expect(formatStreetBetField([0.33], [0.5, 1])).toBe("33");
    expect(encodeBetList(formatStreetBetField([], [0.5, 1]))).toEqual([0.5, 1]);
    expect(encodeBetList(formatStreetBetField([EXPLICIT_EMPTY_SPEC], [0.5, 1]))).toEqual([
      EXPLICIT_EMPTY_SPEC,
    ]);
  });

  it("resolves empty raises to no-raise rather than copying bets", () => {
    expect(formatStreetRaiseField([], [], [0.5])).toBe("-");
    expect(formatStreetRaiseField([EXPLICIT_EMPTY_SPEC], [], [0.5])).toBe("-");
    // Matching street bets stays visible — blank encode means no raises.
    expect(formatStreetRaiseField([0.5], [], [0.5])).toBe("50");
    expect(formatStreetRaiseField([1], [], [0.5])).toBe("100");
    expect(formatStreetRaiseField([], [1], [0.5])).toBe("100");
    expect(encodeRaiseList("", [0.5])).toEqual([EXPLICIT_EMPTY_SPEC]);
    expect(encodeRaiseList(formatStreetRaiseField([], [], [0.5]), [0.5])).toEqual([
      EXPLICIT_EMPTY_SPEC,
    ]);
    expect(encodeRaiseList("50", [0.33])).toEqual([0.5]);
  });

  it("materializes empty donk lists as visible street bet text without copyBets", () => {
    expect(formatDonkField([], [0.5, 1])).toEqual({
      text: "50, 100",
      copyBets: false,
    });
    expect(formatDonkField([EXPLICIT_EMPTY_SPEC], [0.5, 1])).toEqual({
      text: "",
      copyBets: false,
    });
    expect(formatDonkField([0.33], [0.5, 1]).text).toBe("33");
  });

  it("rejects unrecognized and space-delimited size tokens", () => {
    expect(parseSizeListStrict("garbage")).toEqual({
      ok: false,
      errors: [
        {
          token: "garbage",
          message:
            "unrecognized size token (use comma-separated pot %, e, a, Nc)",
        },
      ],
    });
    const mixed = parseSizeListStrict("50, garbage");
    expect(mixed.ok).toBe(false);
    if (!mixed.ok) {
      expect(mixed.errors).toEqual([
        {
          token: "garbage",
          message:
            "unrecognized size token (use comma-separated pot %, e, a, Nc)",
        },
      ]);
    }
    const spaced = parseSizeListStrict("50 100");
    expect(spaced.ok).toBe(false);
    if (!spaced.ok) {
      expect(spaced.errors[0]?.token).toBe("50 100");
    }
    expect(() => encodeBetList("garbage")).toThrow(/garbage/);
    expect(() => encodeBetList("50, garbage")).toThrow(/garbage/);
    expect(() => encodeBetList("50 100")).toThrow(/50 100/);
  });

  it("keeps intentional empty markers and geo/all-in tokens", () => {
    expect(parseSizeListStrict("")).toEqual({
      ok: true,
      specs: [EXPLICIT_EMPTY_SPEC],
    });
    expect(parseSizeListStrict("-")).toEqual({
      ok: true,
      specs: [EXPLICIT_EMPTY_SPEC],
    });
    expect(parseSizeListStrict("none")).toEqual({
      ok: true,
      specs: [EXPLICIT_EMPTY_SPEC],
    });
    expect(parseSizeListStrict("x")).toEqual({
      ok: true,
      specs: [EXPLICIT_EMPTY_SPEC],
    });
    expect(parseSizeListStrict("50, e, a")).toEqual({
      ok: true,
      specs: [0.5, GEO_BASE, -1e9],
    });
    expect(parseSizeListStrict("2.5x", { allowMultiple: true }).ok).toBe(true);
    expect(parseSizeListStrict("2.5x", { allowMultiple: false }).ok).toBe(false);
  });

  it("blank donk always encodes no lead even when donk* flags are true", () => {
    const encoded = encodeBettingJob({
      oopBets: "",
      ipBets: "",
      oopFlop: "50",
      ipFlop: "50",
      oopTurn: "50",
      ipTurn: "50",
      oopRiver: "",
      ipRiver: "",
      oopFlopRaises: "",
      ipFlopRaises: "",
      oopTurnRaises: "",
      ipTurnRaises: "",
      oopRiverRaises: "",
      ipRiverRaises: "",
      oopFlopDonk: "",
      oopTurnDonk: "",
      oopRiverDonk: "",
      donkFlop: true,
      donkTurn: true,
      donkRiver: true,
    });
    expect(encoded.oop_flop_donk).toEqual([EXPLICIT_EMPTY_SPEC]);
    expect(encoded.oop_turn_donk).toEqual([EXPLICIT_EMPTY_SPEC]);
    expect(encoded.oop_river_donk).toEqual([EXPLICIT_EMPTY_SPEC]);
  });

  it("validateBettingLists reports offending tokens by field", () => {
    const errors = validateBettingLists({
      oopBets: "",
      ipBets: "",
      oopFlop: "garbage",
      ipFlop: "50, garbage",
      oopTurn: "50 100",
      ipTurn: "",
      oopRiver: "",
      ipRiver: "",
      oopFlopRaises: "",
      ipFlopRaises: "",
      oopTurnRaises: "",
      ipTurnRaises: "",
      oopRiverRaises: "",
      ipRiverRaises: "",
      oopFlopDonk: "",
      oopTurnDonk: "nope",
      oopRiverDonk: "",
    });
    expect(errors.some((line) => /OOP flop bets: "garbage"/i.test(line))).toBe(
      true,
    );
    expect(errors.some((line) => /IP flop bets: "garbage"/i.test(line))).toBe(
      true,
    );
    expect(errors.some((line) => /OOP turn bets: "50 100"/i.test(line))).toBe(
      true,
    );
    expect(errors.some((line) => /OOP turn donk: "nope"/i.test(line))).toBe(
      true,
    );
  });

  it("encodeBettingJob keeps e and a as list tokens only", () => {
    const encoded = encodeBettingJob({
      oopBets: "",
      ipBets: "",
      oopFlop: "50, e",
      ipFlop: "50",
      oopTurn: "",
      ipTurn: "",
      oopRiver: "50, a",
      ipRiver: "50, a",
      oopFlopRaises: "",
      ipFlopRaises: "",
      oopTurnRaises: "-",
      ipTurnRaises: "-",
      oopRiverRaises: "",
      ipRiverRaises: "",
      oopFlopDonk: "",
      oopTurnDonk: "",
      oopRiverDonk: "",
    });
    expect(encoded).not.toHaveProperty("geometric");
    expect(encoded.oop_flop_bets).toEqual([0.5, GEO_BASE]);
    expect(encoded.oop_river_bets).toEqual([0.5, -1e9]);
    expect(encoded.oop_turn_bets).toEqual([EXPLICIT_EMPTY_SPEC]);
    expect(encoded.oop_turn_raises).toEqual([EXPLICIT_EMPTY_SPEC]);
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

  it("parses engine Raise to N and Bet N all-in into pot tags", () => {
    // Production labels use "Raise to <street_total>", not "Raise N".
    expect(potTagFromLabel("Raise to 400", 300, 100)).toBe("r100");
    expect(formatActionDisplay("Raise to 400", 300, "both", { toCall: 100 })).toEqual(
      {
        primary: "r100",
        secondary: "400.0 chips",
        raw: "Raise to 400",
        potTag: "r100",
      },
    );
    // Without to_call, Raise to still yields a tag (street_total / pot).
    expect(potTagFromLabel("Raise to 400", 200)).toBe("r200");

    // Trailing all-in must not suppress the pot tag (regression).
    expect(potTagFromLabel("Bet 150 all-in", 100)).toBe("b150");
    const allIn = formatActionDisplay("Bet 150 all-in", 100, "both");
    expect(allIn.primary).toBe("b150");
    expect(allIn.secondary).toBe("150.0 chips");
    expect(allIn.raw).toBe("Bet 150 all-in");
    expect(allIn.primary).not.toMatch(/all-?in/i);
    expect(allIn.primary).not.toMatch(/%/);
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
