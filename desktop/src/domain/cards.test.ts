import { describe, expect, it } from "vitest";
import {
  boardBlockers,
  boardGroups,
  chanceCardOptions,
  cycleRank,
  cycleSuit,
  dealStreetFromBoard,
  deckCellIndex,
  deckCoords,
  fullDeckGrid,
  isLegalDeckCell,
  isMissingDeckCell,
  parseCardCode,
  prepareBoardCardChange,
  suitSymbol,
} from "./cards";
import type { NodePayload } from "./types";

describe("card helpers", () => {
  it("parses card codes, suit symbols, and board blockers", () => {
    expect(parseCardCode("Ah")).toEqual({ rank: "A", suit: "h" });
    expect(suitSymbol("h")).toBe("♥");
    expect(suitSymbol("s")).toBe("♠");
    expect([...boardBlockers(["Ah", "Kd"])].sort()).toEqual(["Ah", "Kd"]);
  });

  it("groups flop with separated turn/river", () => {
    expect(boardGroups(["Ah", "Kd", "7c"])).toEqual({
      flop: ["Ah", "Kd", "7c"],
      turn: null,
      river: null,
    });
    expect(boardGroups("Ah Kd 7c 2s 9h")).toEqual({
      flop: ["Ah", "Kd", "7c"],
      turn: "2s",
      river: "9h",
    });
    expect(dealStreetFromBoard(["Ah", "Kd", "7c"])).toBe("turn");
    expect(dealStreetFromBoard(["Ah", "Kd", "7c", "2s"])).toBe("river");
  });

  it("builds chance options and a suits×ranks full deck grid", () => {
    const node: NodePayload = {
      node_id: "c0",
      kind: "chance",
      board: ["Ah", "Kd", "7c"],
      children: [
        { card: "As", node_id: "n1", weight: 0.02 },
        { card: "2h", node_id: "n2", weight: 0.02 },
      ],
    };
    const options = chanceCardOptions(node);
    expect(options).toHaveLength(2);
    const grid = fullDeckGrid(options, node.board);
    expect(grid).toHaveLength(52);
    // suits×ranks: first row is spades, first cell As
    expect(grid[0]?.card).toBe("As");
    expect(grid[deckCellIndex("A", "s")]?.card).toBe("As");
    expect(deckCoords(0)).toEqual({ row: 0, col: 0, suit: "s", rank: "A" });
    const as = grid.find((cell) => cell.card === "As");
    expect(as && isLegalDeckCell(as)).toBe(true);
    const ah = grid.find((cell) => cell.card === "Ah");
    expect(ah && isMissingDeckCell(ah) && ah.blocked).toBe(true);
    // Unavailable non-blocker stays in place, faded via missing
    const kh = grid[deckCellIndex("K", "h")];
    expect(kh && isMissingDeckCell(kh) && !kh.blocked).toBe(true);
  });

  it("cycles ranks and suits for Pio-like keyboard navigation", () => {
    expect(cycleRank("A", 1)).toBe("K");
    expect(cycleRank("2", 1)).toBe("A");
    expect(cycleSuit("s", 1)).toBe("h");
    expect(cycleSuit("c", 1)).toBe("s");
  });

  it("gates board card changes to the live deal street", () => {
    const turnDeal: NodePayload = {
      node_id: "deal-turn",
      kind: "chance",
      board: ["Ah", "Kd", "7c"],
      children: [{ card: "2s", node_id: "after-2s", weight: 0.02 }],
    };
    expect(prepareBoardCardChange(turnDeal, "turn")).toEqual({
      ok: true,
      street: "turn",
      chanceNodeId: "deal-turn",
    });
    expect(prepareBoardCardChange(turnDeal, "river").ok).toBe(false);

    const decision: NodePayload = {
      node_id: "p1",
      kind: "decision",
      board: ["Ah", "Kd", "7c", "2s"],
      actions: ["Check"],
      children: [{ label: "Check", node_id: "p2" }],
    };
    const blocked = prepareBoardCardChange(decision, "turn");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.reason).toMatch(/deal node/i);
      expect(blocked.reason).toMatch(/not wired yet/i);
    }
  });
});
