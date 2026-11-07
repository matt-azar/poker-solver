import { describe, expect, it } from "vitest";
import {
  DEFAULT_BLUFF_EQUITY_THRESHOLD,
  MIN_BET_FREQ,
  betFrequency,
  callChildIdFromFacing,
  dominantBettingActionIndices,
  equityHandsForDominantSizes,
  facingChildIdForBet,
  isBluffBettingAction,
  listProminentBluffs,
  matrixCellForCombo,
  topBettingAction,
  topBettingActionIndex,
} from "./prominentBluffs";
import { fetchPostCallEquityHands } from "./prominentBluffsPostCall";
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

  it("exposes the dominant betting action index", () => {
    expect(topBettingActionIndex([0.2, 0.3, 0.5], ["Check", "Bet 33", "Bet 75"])).toBe(
      2,
    );
  });
});

describe("call-path helpers", () => {
  it("resolves facing and Call child ids", () => {
    const hero = decision({
      actions: ["Check", "Bet 50", "Bet 100"],
      combos: ["AhAd"],
      strategy: [[0.1, 0.2, 0.7]],
      children: ["n-check", "n-bet50", "n-bet100"],
    });
    expect(facingChildIdForBet(hero, 2)).toBe("n-bet100");
    expect(
      callChildIdFromFacing({
        actions: ["Fold", "Call", "Raise to 200"],
        children: ["n-fold", "n-call", "n-raise"],
      }),
    ).toBe("n-call");
    expect(
      callChildIdFromFacing({
        actions: ["Fold"],
        children: ["n-fold"],
      }),
    ).toBeNull();
  });

  it("collects distinct dominant bet sizes across hands", () => {
    const node = decision({
      actions: ["Check", "Bet 50", "Bet 100"],
      combos: ["AhAd", "KhKd", "7h2d"],
      strategy: [
        [0.1, 0.9, 0], // Bet 50
        [0.1, 0.1, 0.8], // Bet 100
        [0.995, 0.005, 0], // below floor
      ],
    });
    expect(dominantBettingActionIndices(node)).toEqual([1, 2]);
  });

  it("builds Mode B equity hands from each hand's dominant size", () => {
    const node = decision({
      actions: ["Check", "Bet 50", "Bet 100"],
      combos: ["AhAd", "KhKd"],
      strategy: [
        [0, 1, 0],
        [0, 0.2, 0.8],
      ],
    });
    const handsByBetAction = new Map([
      [1, [{ combo: "AhAd", equity: 0.11, weight: 1 }]],
      [2, [{ combo: "KhKd", equity: 0.22, weight: 1 }]],
    ]);
    const hands = equityHandsForDominantSizes({ node, handsByBetAction });
    expect(hands).toEqual([
      { combo: "AhAd", equity: 0.11, weight: 1 },
      { combo: "KhKd", equity: 0.22, weight: 1 },
    ]);
    const rows = listProminentBluffs({
      node,
      equityHands: hands,
      threshold: 0.3,
    });
    expect(rows.map((row) => row.combo)).toEqual(["AhAd", "KhKd"]);
    expect(rows[0]!.equity).toBeCloseTo(0.11, 12);
    expect(rows[1]!.equity).toBeCloseTo(0.22, 12);
  });
});

describe("fetchPostCallEquityHands", () => {
  it("walks bet → facing → Call and joins hero equity", async () => {
    const hero = decision({
      player: 0,
      actions: ["Check", "Bet 50"],
      combos: ["AhAd", "7h2d"],
      strategy: [
        [0.2, 0.8],
        [0.1, 0.9],
      ],
      children: ["n-check", "n-bet50"],
    });
    const facing: NodePayload = {
      node_id: "n-bet50",
      kind: "decision",
      actions: ["Fold", "Call"],
      children: ["n-fold", "n-call"],
      combos: [],
    };
    const result = await fetchPostCallEquityHands({
      solutionId: "s1",
      node: hero,
      heroPlayer: 0,
      deps: {
        getNode: async (_sid, nodeId) => {
          expect(nodeId).toBe("n-bet50");
          return facing;
        },
        getEquity: async (_sid, nodeId) => {
          expect(nodeId).toBe("n-call");
          return {
            pending: false,
            oop_hands: [
              { combo: "AhAd", equity: 0.4, weight: 1 },
              { combo: "7h2d", equity: 0.08, weight: 1 },
            ],
            ip_hands: [],
          };
        },
      },
    });
    expect(result.error).toBeNull();
    expect(result.callNodeIds).toEqual(["n-call"]);
    expect(result.hands.map((hand) => hand.combo)).toEqual(["AhAd", "7h2d"]);
    const rows = listProminentBluffs({
      node: hero,
      equityHands: result.hands,
      threshold: 0.3,
    });
    // AhAd equity 0.4 is not a bluff; 7h2d at 0.08 is.
    expect(rows.map((row) => row.combo)).toEqual(["7h2d"]);
  });

  it("reports missing Call children", async () => {
    const hero = decision({
      actions: ["Bet 50"],
      combos: ["AhAd"],
      strategy: [[1]],
      children: ["n-bet50"],
    });
    const result = await fetchPostCallEquityHands({
      solutionId: "s1",
      node: hero,
      heroPlayer: 0,
      deps: {
        getNode: async () => ({
          node_id: "n-bet50",
          kind: "decision",
          actions: ["Fold"],
          children: ["n-fold"],
          combos: [],
        }),
        getEquity: async () => {
          throw new Error("should not fetch equity");
        },
      },
    });
    expect(result.hands).toEqual([]);
    expect(result.missingCallCount).toBe(1);
    expect(result.error).toMatch(/No Call child/i);
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
