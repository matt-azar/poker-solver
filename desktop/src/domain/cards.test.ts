import { describe, expect, it } from "vitest";
import {
  boardBlockers,
  boardCardChangeBlockedByLaterStreet,
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
  isDealChanceForStreet,
  isLegalDeckCell,
  isMissingDeckCell,
  linePreservingCardTargetId,
  parseCardCode,
  parsePublicNodeId,
  prepareBoardCardChange,
  resolveDealChanceIdFromTrail,
  rewriteNodeIdRunout,
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

  it("parses and rewrites pN.tT.rR runouts while keeping public index N", () => {
    expect(parsePublicNodeId("p12.t40.r7")).toEqual({
      index: 12,
      turn: 40,
      river: 7,
    });
    expect(parsePublicNodeId("n:root/c")).toBeNull();
    expect(rewriteNodeIdRunout("p42.t15.r28", "p5.t15.r9")).toBe("p42.t15.r9");
    expect(rewriteNodeIdRunout("p42.t15.r-1", "p5.t22.r-1")).toBe("p42.t22.r-1");
    expect(rewriteNodeIdRunout("decision", "p5.t15.r9")).toBeNull();
    expect(linePreservingCardTargetId("p3.t-1.r-1", "p3.t-1.r-1", "p4.t11.r-1")).toBe(
      "p4.t11.r-1",
    );
    expect(linePreservingCardTargetId("p42.t15.r28", "p3.t15.r-1", "p5.t15.r9")).toBe(
      "p42.t15.r9",
    );
  });

  it("resolves deal-chance ids from pathTrail card steps", () => {
    const trail = [
      { nodeId: "p0.t-1.r-1", kind: "root", street: "flop" },
      { nodeId: "p1.t-1.r-1", kind: "action", street: "flop" },
      { nodeId: "p2.t-1.r-1", kind: "action", street: "flop" }, // turn deal chance
      {
        nodeId: "p4.t15.r-1",
        kind: "card",
        street: "turn",
        parentId: "p0.t-1.r-1",
      },
      { nodeId: "p8.t15.r-1", kind: "action", street: "turn" },
    ];
    expect(resolveDealChanceIdFromTrail(trail, "turn")).toBe("p2.t-1.r-1");
    expect(resolveDealChanceIdFromTrail(trail, "river")).toBeNull();
    expect(
      resolveDealChanceIdFromTrail(
        [
          {
            nodeId: "p9.t15.r3",
            kind: "card",
            street: "river",
            parentId: "p7.t15.r-1",
          },
        ],
        "river",
      ),
    ).toBe("p7.t15.r-1");
  });

  it("accepts live deal nodes and resolved ancestors for board card changes", () => {
    const turnDeal: NodePayload = {
      node_id: "p2.t-1.r-1",
      kind: "chance",
      board: ["Ah", "Kd", "7c"],
      cards: [{ card: "2s", child_id: "p4.t15.r-1", weight: 0.02 }],
    };
    expect(isDealChanceForStreet(turnDeal, "turn")).toBe(true);
    expect(prepareBoardCardChange(turnDeal, "turn")).toEqual({
      ok: true,
      street: "turn",
      chanceNodeId: "p2.t-1.r-1",
    });
    expect(prepareBoardCardChange(turnDeal, "river").ok).toBe(false);

    const decision: NodePayload = {
      node_id: "p8.t15.r-1",
      kind: "decision",
      board: ["Ah", "Kd", "7c", "2s"],
      actions: ["Check"],
      children: [{ label: "Check", node_id: "p9.t15.r-1" }],
      parent_id: "p4.t15.r-1",
    };
    const withoutAncestor = prepareBoardCardChange(decision, "turn");
    expect(withoutAncestor.ok).toBe(false);
    if (!withoutAncestor.ok) {
      expect(withoutAncestor.reason).toMatch(/deal-chance ancestor/i);
      expect(withoutAncestor.reason).not.toMatch(/not wired yet/i);
    }

    expect(prepareBoardCardChange(decision, "turn", turnDeal)).toEqual({
      ok: true,
      street: "turn",
      chanceNodeId: "p2.t-1.r-1",
    });

    const riverDecision: NodePayload = {
      node_id: "p20.t15.r9",
      kind: "decision",
      board: ["Ah", "Kd", "7c", "2s", "9h"],
      parent_id: "p18.t15.r9",
    };
    expect(boardCardChangeBlockedByLaterStreet(riverDecision, "turn")).toMatch(
      /after the river/i,
    );
    expect(prepareBoardCardChange(riverDecision, "turn", turnDeal).ok).toBe(false);

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
