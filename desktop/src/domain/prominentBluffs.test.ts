import { describe, expect, it } from "vitest";
import {
  DEFAULT_BLUFF_EQUITY_THRESHOLD,
  MIN_BET_FREQ,
  betFrequency,
  isBluffBettingAction,
  listProminentBluffs,
  matrixCellForCombo,
  topBettingAction,
} from "./prominentBluffs";
import type { NodePayload } from "./types";

function decision(partial: Partial<NodePayload> & Pick<NodePayload, "combos" | "actions" | "strategy">): NodePayload {
  return {
    node_id: "p0",
    kind: "decision",
    player: 0,
    reach_defined: true,
    reach: partial.combos.map(() => 1),
    marginal: partial.combos.map(() => 1),
    ...partial,
  };
}

describe("isBluffBettingAction", () => {
  it("counts Bet, Raise, sized all-in, and bare All-in", () => {
    expect(isBluffBettingAction("Bet 50")).toBe(true);
    expect(isBluffBettingAction("Raise to 100")).toBe(true);
    expect(isBluffBettingAction("Bet 100 all-in")).toBe(true);
    expect(isBluffBettingAction("All-in")).toBe(true);
    expect(isBluffBettingAction("all in")).toBe(true);
  });

  it("rejects passive actions", () => {
    expect(isBluffBettingAction("Check")).toBe(false);
    expect(isBluffBettingAction("Fold")).toBe(false);
    expect(isBluffBettingAction("Call")).toBe(false);
  });
});

describe("betFrequency / topBettingAction", () => {
  it("sums multi-size bets and picks the max-prob size", () => {
    const actions = ["Check", "Bet 33", "Bet 75"];
    const row = [0.2, 0.3, 0.5];
    expect(betFrequency(row, actions)).toBeCloseTo(0.8, 12);
    expect(topBettingAction(row, actions)).toBe("Bet 75");
  });

  it("includes bare All-in in the sum", () => {
    const actions = ["Check", "All-in"];
    expect(betFrequency([0.4, 0.6], actions)).toBeCloseTo(0.6, 12);
  });
});

describe("matrixCellForCombo", () => {
  it("maps pairs, suited, and offsuit like the matrix", () => {
    expect(matrixCellForCombo("AhAd")).toEqual({ row: 0, col: 0, text: "AA" });
    expect(matrixCellForCombo("AhKh")).toEqual({ row: 0, col: 1, text: "AKs" });
    expect(matrixCellForCombo("AhKd")).toEqual({ row: 1, col: 0, text: "AKo" });
  });
});

describe("listProminentBluffs", () => {
  const node = decision({
    actions: ["Check", "Bet 50", "Bet 100", "All-in"],
    combos: ["AhAd", "KhKd", "7h2d", "9h9d", "2c2d"],
    strategy: [
      [0.1, 0.9, 0, 0], // AA bets 90%
      [0.5, 0.5, 0, 0], // KK bets 50%
      [0.2, 0.3, 0.5, 0], // 72o multi-size 80%
      [0.995, 0.005, 0, 0], // 99 below 1% floor
      [0, 0, 0, 1], // 22 all-in 100%
    ],
    reach: [1, 1, 1, 1, 1],
  });

  const hands = [
    { combo: "AhAd", equity: 0.8, weight: 1 },
    { combo: "KhKd", equity: 0.25, weight: 0.5 },
    { combo: "7h2d", equity: 0.1, weight: 0.2 },
    { combo: "9h9d", equity: 0.15, weight: 1 },
    { combo: "2c2d", equity: 0.05, weight: 1 },
  ];

  it("filters equity < threshold, betFreq >= 1%, sorts by bet freq", () => {
    const rows = listProminentBluffs({
      node,
      equityHands: hands,
      threshold: DEFAULT_BLUFF_EQUITY_THRESHOLD,
    });
    expect(rows.map((row) => row.combo)).toEqual(["2c2d", "7h2d", "KhKd"]);
    expect(rows[0]!.betFreq).toBeCloseTo(1, 12);
    expect(rows[1]!.betFreq).toBeCloseTo(0.8, 12);
    expect(rows[2]!.betFreq).toBeCloseTo(0.5, 12);
    expect(rows.every((row) => row.equity < 0.3)).toBe(true);
    expect(MIN_BET_FREQ).toBe(0.01);
  });

  it("excludes missing equity and check-only / high-equity hands", () => {
    const rows = listProminentBluffs({
      node: decision({
        actions: ["Check", "Bet 50"],
        combos: ["AhAd", "KhKd"],
        strategy: [
          [0, 1],
          [1, 0],
        ],
      }),
      equityHands: [{ combo: "AhAd", equity: 0.2, weight: 1 }],
      threshold: 0.3,
    });
    // AhAd would qualify but we only listed KhKd as check-only / missing from filter:
    // AhAd has equity 0.2 and bets 100% → included; KhKd checks only → excluded.
    expect(rows.map((row) => row.combo)).toEqual(["AhAd"]);
  });

  it("uses strict less-than on the threshold", () => {
    const rows = listProminentBluffs({
      node: decision({
        actions: ["Bet 50"],
        combos: ["AhAd"],
        strategy: [[1]],
      }),
      equityHands: [{ combo: "AhAd", equity: 0.3, weight: 1 }],
      threshold: 0.3,
    });
    expect(rows).toEqual([]);
  });

  it("joins equity via comboKey canonicalization", () => {
    const rows = listProminentBluffs({
      node: decision({
        actions: ["Check", "Bet 50"],
        combos: ["AdAh"],
        strategy: [[0.2, 0.8]],
      }),
      equityHands: [{ combo: "AhAd", equity: 0.12, weight: 1 }],
      threshold: 0.3,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.combo).toBe("AdAh");
    expect(rows[0]!.equity).toBeCloseTo(0.12, 12);
  });

  it("returns empty for chance nodes or missing strategy", () => {
    expect(
      listProminentBluffs({
        node: { node_id: "c", kind: "chance", combos: ["AhAd"], actions: ["Bet 50"], strategy: [[1]] },
        equityHands: hands,
        threshold: 0.3,
      }),
    ).toEqual([]);
  });

  it("tie-breaks equal bet frequency by combo string", () => {
    const rows = listProminentBluffs({
      node: decision({
        actions: ["Bet 50"],
        combos: ["KhKd", "AhAd"],
        strategy: [[1], [1]],
      }),
      equityHands: [
        { combo: "AhAd", equity: 0.1, weight: 1 },
        { combo: "KhKd", equity: 0.1, weight: 1 },
      ],
      threshold: 0.3,
    });
    expect(rows.map((row) => row.combo)).toEqual(["AhAd", "KhKd"]);
  });
});
