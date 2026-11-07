import { beforeEach, describe, expect, it } from "vitest";
import { groupHands } from "./browse";
import {
  comboBadgeCards,
  comboBreakdown,
  comboEv,
  comboHoverPaint,
  comboHoverShowEquity,
  comboHoverShowEv,
  DEFAULT_MATRIX_DISPLAY_PREFS,
  equityByCombo,
  equityHandsForNode,
  equitySeatForPlayer,
  expectedComboSlots,
  formatEquityPct,
  formatEvChip,
  groupEquity,
  normalizeMatrixDisplayPrefs,
  overlaySubLabel,
  useMatrixDisplayStore,
  weightFillFraction,
} from "./matrixDisplay";
import { RANKS } from "./types";

describe("matrixDisplay prefs", () => {
  beforeEach(() => {
    localStorage.clear();
    useMatrixDisplayStore.getState().resetPrefs();
  });

  it("normalizes unknown overlay values", () => {
    expect(
      normalizeMatrixDisplayPrefs({ cellOverlay: "nope" as never }).cellOverlay,
    ).toBe("none");
    expect(normalizeMatrixDisplayPrefs(null)).toEqual(DEFAULT_MATRIX_DISPLAY_PREFS);
  });

  it("persists prefs through the colocated store", () => {
    useMatrixDisplayStore.getState().setRangeWeightHeightFill(true);
    useMatrixDisplayStore.getState().setCellOverlay("equity");
    expect(useMatrixDisplayStore.getState().prefs.rangeWeightHeightFill).toBe(true);
    expect(useMatrixDisplayStore.getState().prefs.cellOverlay).toBe("equity");
    const raw = localStorage.getItem("study-matrix-display-v1");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).rangeWeightHeightFill).toBe(true);
  });
});

describe("combo hover paint", () => {
  it("mirrors matrix mode and overlays for strategy / EV / equity", () => {
    expect(comboHoverPaint("strategy")).toBe("strategy");
    expect(comboHoverPaint("strategy-ev")).toBe("strategy");
    expect(comboHoverPaint("range")).toBe("range");
    expect(comboHoverPaint("ev")).toBe("ev");
    expect(comboHoverShowEv("strategy", "none")).toBe(false);
    expect(comboHoverShowEv("strategy", "ev")).toBe(true);
    expect(comboHoverShowEv("strategy-ev", "none")).toBe(true);
    expect(comboHoverShowEv("ev", "none")).toBe(true);
    expect(comboHoverShowEquity("strategy", "equity")).toBe(true);
    expect(comboHoverShowEquity("strategy", "none")).toBe(false);
    expect(comboHoverShowEquity("strategy", "both")).toBe(true);
  });
});

describe("equity aggregation", () => {
  it("maps acting seat to equity hands", () => {
    expect(equitySeatForPlayer(0)).toBe("oop");
    expect(equitySeatForPlayer(1)).toBe("ip");
    expect(equitySeatForPlayer(null)).toBeNull();
    const payload = {
      oop_hands: [{ combo: "AhAd", equity: 0.8, weight: 1 }],
      ip_hands: [{ combo: "KhKd", equity: 0.2, weight: 1 }],
    };
    expect(equityHandsForNode(payload, 0)?.[0]?.combo).toBe("AhAd");
    expect(equityHandsForNode(payload, 1)?.[0]?.combo).toBe("KhKd");
    expect(equityHandsForNode({ pending: true, oop_hands: payload.oop_hands }, 0)).toBeNull();
  });

  it("averages cell equity weighted by reach", () => {
    const node = {
      node_id: "n",
      player: 0,
      reach_defined: true,
      actions: ["Check"],
      combos: ["AhAd", "AsAc", "AhAs"],
      reach: [1, 0.5, 0],
      marginal: [0.5, 0.5, 0],
      strategy: [[1], [1], [1]],
    };
    const aa = groupHands(node).find((c) => c.text === "AA")!;
    const map = equityByCombo([
      { combo: "AhAd", equity: 0.8 },
      { combo: "AsAc", equity: 0.4 },
      { combo: "AhAs", equity: 0.9 },
    ]);
    // (1*0.8 + 0.5*0.4) / 1.5 = 0.666...
    expect(groupEquity(aa, map, node)).toBeCloseTo(2 / 3, 12);
  });

  it("falls back to unweighted mean when reach is missing", () => {
    const node = {
      node_id: "n",
      reach_defined: false,
      actions: ["Check"],
      combos: ["AhKh", "AdKd"],
      strategy: [[1], [1]],
    };
    const aks = groupHands(node).find((c) => c.text === "AKs")!;
    const map = equityByCombo([
      { combo: "AhKh", equity: 0.6 },
      { combo: "AdKd", equity: 0.4 },
    ]);
    expect(groupEquity(aks, map, node)).toBeCloseTo(0.5, 12);
  });

  it("returns null when equity is unloaded", () => {
    const node = {
      node_id: "n",
      reach_defined: true,
      actions: ["Check"],
      combos: ["AhAd"],
      reach: [1],
      marginal: [1],
      strategy: [[1]],
    };
    const aa = groupHands(node).find((c) => c.text === "AA")!;
    expect(groupEquity(aa, new Map(), node)).toBeNull();
  });
});

describe("overlay labels and weight fill", () => {
  it("formats overlay sub labels", () => {
    expect(overlaySubLabel("none", 1.2, 0.55)).toBe("");
    expect(overlaySubLabel("ev", 1.25, 0.55)).toBe("1.3");
    expect(overlaySubLabel("equity", 1.25, 0.55)).toBe("55");
    expect(overlaySubLabel("both", 1.25, 0.55)).toBe("1.3/55");
    expect(overlaySubLabel("equity", null, null)).toBe("—");
    expect(formatEquityPct(0.555)).toBe("56");
    expect(formatEvChip(null)).toBe("—");
  });

  it("clips weight-fill fraction", () => {
    expect(weightFillFraction(false, 0.3)).toBe(1);
    expect(weightFillFraction(true, 0.3)).toBeCloseTo(0.3, 12);
    expect(weightFillFraction(true, null)).toBe(0);
    expect(weightFillFraction(true, 1.5)).toBe(1);
  });
});

describe("comboBadgeCards", () => {
  it("formats rank + suit glyph cards for a white badge", () => {
    expect(comboBadgeCards("AcQc")).toEqual([
      { rank: "A", suit: "c", symbol: "♣", red: false },
      { rank: "Q", suit: "c", symbol: "♣", red: false },
    ]);
    expect(comboBadgeCards("AhKd")[0]).toMatchObject({
      rank: "A",
      suit: "h",
      symbol: "♥",
      red: true,
    });
  });
});

describe("combo breakdown slots", () => {
  it("emits 6/4/12 suit-pair slots", () => {
    expect(expectedComboSlots(0, 0, RANKS)).toHaveLength(6);
    expect(expectedComboSlots(0, 1, RANKS)).toHaveLength(4);
    expect(expectedComboSlots(1, 0, RANKS)).toHaveLength(12);
    expect(expectedComboSlots(0, 0, RANKS)[0]?.combo).toBe("AdAc");
    expect(expectedComboSlots(0, 1, RANKS).map((s) => s.combo)).toEqual([
      "AcKc",
      "AdKd",
      "AhKh",
      "AsKs",
    ]);
  });

  it("fills breakdown with reach, EV, and equity per present combo", () => {
    const node = {
      node_id: "n",
      player: 0,
      reach_defined: true,
      actions: ["Check", "Bet 50"],
      combos: ["AhAd", "AsAc"],
      reach: [1, 0.5],
      marginal: [1, 0.5],
      strategy: [
        [0.5, 0.5],
        [1, 0],
      ],
    };
    const values = {
      node_id: "n",
      combos: ["AhAd", "AsAc"],
      ev_defined: [true, true],
      value: [2, 4],
      action_ev: [
        [0, 4],
        [4, 4],
      ],
    };
    const aa = groupHands(node).find((c) => c.text === "AA")!;
    const map = equityByCombo([
      { combo: "AhAd", equity: 0.8 },
      { combo: "AsAc", equity: 0.6 },
    ]);
    const squares = comboBreakdown(aa, node, values, map, "local", RANKS);
    expect(squares).toHaveLength(6);
    const present = squares.filter((s) => s.present);
    expect(present).toHaveLength(2);
    const ahAd = squares.find((s) => s.combo === "AhAd")!;
    expect(ahAd.reach).toBeCloseTo(1, 12);
    expect(ahAd.equity).toBeCloseTo(0.8, 12);
    expect(ahAd.ev).toBeCloseTo(2, 12);
    expect(comboEv(node, values, "AhAd", "local")).toBeCloseTo(2, 12);
    expect(squares.filter((s) => !s.present).every((s) => s.ev === null)).toBe(true);
  });
});
