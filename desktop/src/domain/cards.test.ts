import { describe, expect, it } from "vitest";
import {
  boardBlockers,
  boardGroups,
  chanceCardChildId,
  chanceCardEntries,
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
import engineChanceRiverDeal from "./fixtures/engine-chance-river-deal.json";

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

  it("normalizes engine chance cards[] with child_id (not children/node_id)", () => {
    const node = engineChanceRiverDeal as NodePayload;
    expect(node.kind).toBe("chance");
    expect(Array.isArray(node.children) && node.children).toEqual([]);
    expect(Array.isArray(node.cards) && (node.cards as unknown[]).length).toBeGreaterThan(0);

    const entries = chanceCardEntries(node);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]).toMatchObject({
      card: "As",
      child_id: "n:root/c/As",
    });
    expect(chanceCardChildId(entries[0]!)).toBe("n:root/c/As");

    const options = chanceCardOptions(node);
    expect(options.length).toBe(entries.length);
    const as = options.find((option) => option.card === "As");
    expect(as).toMatchObject({
      card: "As",
      rank: "A",
      suit: "s",
      nodeId: "n:root/c/As",
      blocked: false,
    });
    expect(as?.weight).toBeCloseTo(0.0208333333333, 9);

    const grid = fullDeckGrid(options, node.board);
    expect(grid).toHaveLength(52);
    expect(grid[0]?.card).toBe("As");
    expect(grid[deckCellIndex("A", "s")]?.card).toBe("As");
    expect(deckCoords(0)).toEqual({ row: 0, col: 0, suit: "s", rank: "A" });
    expect(as && isLegalDeckCell(as)).toBe(true);

    // Board blockers stay in stable grid slots, faded.
    for (const blocked of ["Ah", "Kd", "7c", "4s"]) {
      const cell = grid.find((entry) => entry.card === blocked);
      expect(cell && isMissingDeckCell(cell) && cell.blocked).toBe(true);
    }
    // Unavailable non-blocker stays in place, faded via missing
    const qsMissingSuit = grid[deckCellIndex("Q", "h")];
    expect(qsMissingSuit && isMissingDeckCell(qsMissingSuit) && !qsMissingSuit.blocked).toBe(
      true,
    );

    expect(prepareBoardCardChange(node, "river")).toEqual({
      ok: true,
      street: "river",
      chanceNodeId: "n:root/c",
    });
  });

  it("still accepts legacy children[{card, node_id}] fixtures", () => {
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
    expect(options.map((option) => option.nodeId).sort()).toEqual(["n1", "n2"]);
  });

  it("prefers engine cards[] when both cards and children are present", () => {
    const node: NodePayload = {
      node_id: "c0",
      kind: "chance",
      board: ["Ah", "Kd", "7c"],
      cards: [{ card: "As", child_id: "from-cards", weight: 0.02 }],
      children: [{ card: "As", node_id: "from-children", weight: 0.02 }],
    };
    expect(chanceCardOptions(node)).toEqual([
      expect.objectContaining({ card: "As", nodeId: "from-cards" }),
    ]);
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
      cards: [{ card: "2s", child_id: "after-2s", weight: 0.02 }],
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

    const emptyChance: NodePayload = {
      node_id: "deal-empty",
      kind: "chance",
      board: ["Ah", "Kd", "7c", "2s"],
      children: [],
      cards: [],
    };
    const noCards = prepareBoardCardChange(emptyChance, "river");
    expect(noCards.ok).toBe(false);
    if (!noCards.ok) {
      expect(noCards.reason).toMatch(/No legal next cards/i);
    }
  });
});
