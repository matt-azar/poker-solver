import { describe, expect, it } from "vitest";
import { parseRangeText, comboCount } from "../range";
import {
  blendWeightGrids,
  interpolateProfilesByStack,
  pickStackBracket,
} from "./interpolate";
import type { RangeProfile } from "./types";

function profile(partial: {
  id: string;
  stack: number;
  oop: string;
  ip: string;
  stakes?: string;
}): RangeProfile {
  return {
    schemaVersion: 1,
    id: partial.id,
    dataRevision: "1",
    displayName: partial.id,
    format: "cash_6max",
    playerCount: 6,
    positions: { oop: "BB", ip: "BTN" },
    preflopActions: [
      { position: "BTN", kind: "open", sizeBb: 2.5 },
      { position: "BB", kind: "call", sizeBb: 1.5 },
    ],
    startingStackBb: partial.stack,
    blinds: { sb: 0.5, bb: 1 },
    rake: { rate: 0, cap: 0, collection: "none", known: true },
    labels: { stakes: partial.stakes ?? "cEV" },
    ranges: { oop: partial.oop, ip: partial.ip },
    provenance: {
      source: "test",
      classification: "population_estimate",
    },
  };
}

describe("interpolateProfilesByStack", () => {
  it("blends midpoint stacks toward an in-between target", () => {
    const low = profile({
      id: "btn-bb-150",
      stack: 150,
      oop: "AA,KK",
      ip: "AA",
    });
    const high = profile({
      id: "btn-bb-200",
      stack: 200,
      oop: "AA,KK,QQ",
      ip: "AA,KK",
    });
    const mid = interpolateProfilesByStack({
      low,
      high,
      targetStackBb: 175,
    });
    expect(mid.t).toBeCloseTo(0.5, 6);
    expect(mid.oopRange).toContain("AA");
    // QQ only on the high side → half weight at midpoint.
    const oop = parseRangeText(mid.oopRange);
    // QQ is ranks Q=2 (A=0,K=1,Q=2)
    expect(oop[2][2]).toBeCloseTo(0.5, 5);
    expect(comboCount(oop, "")).toBeGreaterThan(2);
  });

  it("pickStackBracket finds surrounding depth packs", () => {
    const catalogue = [
      profile({ id: "a100", stack: 100, oop: "AA", ip: "KK" }),
      profile({ id: "a150", stack: 150, oop: "AA,KK", ip: "KK" }),
      profile({ id: "a200", stack: 200, oop: "AA,KK,QQ", ip: "KK,QQ" }),
    ];
    const bracket = pickStackBracket(catalogue, {
      targetStackBb: 170,
      positions: { oop: "BB", ip: "BTN" },
      potType: "SRP",
      stakesLabel: "cEV",
    });
    expect(bracket?.low.id).toBe("a150");
    expect(bracket?.high.id).toBe("a200");
  });
});

describe("blendWeightGrids", () => {
  it("returns left at t=0 and right at t=1", () => {
    const left = parseRangeText("AA");
    const right = parseRangeText("KK");
    expect(blendWeightGrids(left, right, 0)[0][0]).toBe(1);
    expect(blendWeightGrids(left, right, 0)[1][1]).toBe(0);
    expect(blendWeightGrids(left, right, 1)[0][0]).toBe(0);
    expect(blendWeightGrids(left, right, 1)[1][1]).toBe(1);
  });
});
