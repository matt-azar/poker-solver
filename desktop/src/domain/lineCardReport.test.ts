import { describe, expect, it } from "vitest";
import {
  aggregateActionFrequency,
  filterAndSortLineCardRows,
  fixedBoardForLineCard,
  LINE_CARD_GRID_RANKS,
  lineCardEquityFromPayload,
  lineCardEvFromValues,
  lineCardReportStreet,
  lineCardTargetId,
  matchesLineCardPredicate,
  readNodeJoint,
  resolveLineCardAction,
  rowFromResolvedNode,
  unavailableRow,
  withLineCardReportFilter,
  type LineCardReportRow,
} from "./lineCardReport";
import type { ChanceCardOption } from "./cards";
import type { NodePayload } from "./types";

const option: ChanceCardOption = {
  card: "As",
  rank: "A",
  suit: "s",
  nodeId: "p0.t40.r-1",
  weight: 0.02,
  blocked: false,
};

function decisionNode(partial: Partial<NodePayload>): NodePayload {
  return {
    node_id: "p12.t40.r-1",
    kind: "decision",
    actions: ["Check", "Bet 50"],
    strategy: [
      [1, 0],
      [0, 1],
    ],
    marginal: [0.5, 0.5],
    combos: ["AhAd", "KhKd"],
    reach: [0.5, 0.5],
    reach_defined: true,
    joint: 0.25,
    ...partial,
  };
}

describe("line card grid", () => {
  it("orders ranks from deuce on the left to ace on the right", () => {
    expect(LINE_CARD_GRID_RANKS[0]).toBe("2");
    expect(LINE_CARD_GRID_RANKS[LINE_CARD_GRID_RANKS.length - 1]).toBe("A");
    expect(LINE_CARD_GRID_RANKS).toHaveLength(13);
  });

  it("reads acting-player EV and equity", () => {
    expect(
      lineCardEvFromValues(
        {
          node_ev: 3,
          node_ev_defined: true,
          utility_basis: "local",
          local_offset: 0,
        },
        "local",
        ["Check"],
      ),
    ).toBe(3);
    expect(
      lineCardEquityFromPayload({ oop_equity: 0.25, ip_equity: 0.75 }, 1),
    ).toBe(0.75);
    expect(lineCardEquityFromPayload({ pending: true, oop_equity: 0.25 }, 0)).toBe(
      null,
    );
  });
});

describe("lineCardReportStreet", () => {
  it("varies turn on a four-card board and river on five", () => {
    expect(lineCardReportStreet(["Ah", "Kd", "7c", "2s"])).toBe("turn");
    expect(lineCardReportStreet(["Ah", "Kd", "7c", "2s", "3h"])).toBe("river");
    expect(lineCardReportStreet(["Ah", "Kd", "7c"])).toBeNull();
  });
});

describe("lineCardTargetId", () => {
  it("keeps the public betting index while swapping the runout", () => {
    expect(
      lineCardTargetId("p12.t10.r-1", "p0.t-1.r-1", "p0.t40.r-1"),
    ).toBe("p12.t40.r-1");
  });
});

describe("readNodeJoint / row builders", () => {
  it("keeps empty reach distinct from a missing joint", () => {
    expect(readNodeJoint({ node_id: "p0.t-1.r-1", joint: 0 })).toEqual({
      reach: 0,
      reachDefined: true,
      zeroReach: true,
    });
    expect(readNodeJoint({ node_id: "p0.t-1.r-1" }).reachDefined).toBe(false);
  });

  it("marks zero-reach available rows and unavailable missing lines", () => {
    const zero = rowFromResolvedNode(
      option,
      decisionNode({ joint: 0, strategy: [[1, 0], [1, 0]], marginal: [1, 0] }),
      ["Check", "Bet 50"],
    );
    expect(zero.available).toBe(true);
    expect(zero.zeroReach).toBe(true);
    expect(zero.reason).toBe("Zero joint reach");

    const missing = unavailableRow(option, "Line unavailable on this card");
    expect(missing.available).toBe(false);
    expect(missing.dealProbability).toBe(0.02);
  });

  it("flags a mismatched action set without dropping deal probability", () => {
    const row = rowFromResolvedNode(
      option,
      decisionNode({ actions: ["Check"] }),
      ["Check", "Bet 50"],
    );
    expect(row.available).toBe(false);
    expect(row.reason).toMatch(/Action set/);
    expect(row.dealProbabilityDefined).toBe(true);
  });
});

describe("aggregateActionFrequency", () => {
  it("weights by reach and ignores empty-reach or unavailable rows", () => {
    const rows = [
      rowFromResolvedNode(
        { ...option, card: "As", weight: 0.1 },
        decisionNode({
          node_id: "p12.t40.r-1",
          joint: 0.2,
          strategy: [
            [1, 0],
            [1, 0],
          ],
          marginal: [1, 0],
        }),
        ["Check", "Bet 50"],
      ),
      rowFromResolvedNode(
        { ...option, card: "Ks", weight: 0.1 },
        decisionNode({
          node_id: "p12.t41.r-1",
          joint: 0.8,
          strategy: [
            [0, 1],
            [0, 1],
          ],
          marginal: [1, 0],
        }),
        ["Check", "Bet 50"],
      ),
      {
        ...unavailableRow({ ...option, card: "Qs" }, "blocked"),
        reach: 10,
        reachDefined: true,
        frequencies: [0, 1],
      },
      rowFromResolvedNode(
        { ...option, card: "Js", weight: 0.1 },
        decisionNode({
          node_id: "p12.t42.r-1",
          joint: 0,
          strategy: [
            [0, 1],
            [0, 1],
          ],
          marginal: [1, 0],
        }),
        ["Check", "Bet 50"],
      ),
    ];
    // Reach mass 0.2 at Check=1 and 0.8 at Bet=1 → bet aggregate 0.8.
    expect(aggregateActionFrequency(rows, 0)).toBeCloseTo(0.2, 8);
    expect(aggregateActionFrequency(rows, 1)).toBeCloseTo(0.8, 8);
  });
});

describe("line card predicates and action resolve", () => {
  it("matches heart non-pairing rivers against the fixed board", () => {
    const board = ["Ah", "Kd", "7c", "2s", "3d"];
    expect(fixedBoardForLineCard(board, "river")).toEqual(["Ah", "Kd", "7c", "2s"]);
    expect(
      matchesLineCardPredicate("5h", board, "river", {
        suits: ["h"],
        excludeBoardPair: true,
      }),
    ).toBe(true);
    expect(
      matchesLineCardPredicate("Ah", board, "river", {
        suits: ["h"],
        excludeBoardPair: true,
      }),
    ).toBe(false);
    expect(
      matchesLineCardPredicate("5s", board, "river", {
        suits: ["h"],
        excludeBoardPair: true,
      }),
    ).toBe(false);
  });

  it("resolves 75% to Bet 75 and rejects missing sizes", () => {
    const labels = ["Check", "Bet 33", "Bet 75"];
    expect(resolveLineCardAction(labels, "75%")).toEqual({
      ok: true,
      index: 2,
      label: "Bet 75",
    });
    expect(resolveLineCardAction(labels, "Bet 75")).toEqual({
      ok: true,
      index: 2,
      label: "Bet 75",
    });
    const missing = resolveLineCardAction(labels, "100%");
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.reason).toMatch(/not available/i);
      expect(missing.supported).toEqual(labels);
    }
  });

  it("filters and ranks rows by action frequency like the manual report order", () => {
    const board = ["Ah", "Kd", "7c", "2s", "3d"];
    const rows: LineCardReportRow[] = [
      {
        card: "5h",
        dealProbability: 0.02,
        dealProbabilityDefined: true,
        reach: 0.1,
        reachDefined: true,
        zeroReach: false,
        available: true,
        reason: null,
        resolvedNodeId: "n-5h",
        actions: ["Check", "Bet 75"],
        frequencies: [0.2, 0.8],
        player: 1,
      },
      {
        card: "9h",
        dealProbability: 0.02,
        dealProbabilityDefined: true,
        reach: 0.1,
        reachDefined: true,
        zeroReach: false,
        available: true,
        reason: null,
        resolvedNodeId: "n-9h",
        actions: ["Check", "Bet 75"],
        frequencies: [0.4, 0.6],
        player: 1,
      },
      {
        card: "Ah",
        dealProbability: 0.02,
        dealProbabilityDefined: true,
        reach: 0.1,
        reachDefined: true,
        zeroReach: false,
        available: true,
        reason: null,
        resolvedNodeId: "n-Ah",
        actions: ["Check", "Bet 75"],
        frequencies: [0.1, 0.9],
        player: 1,
      },
      {
        card: "5s",
        dealProbability: 0.02,
        dealProbabilityDefined: true,
        reach: 0.1,
        reachDefined: true,
        zeroReach: false,
        available: true,
        reason: null,
        resolvedNodeId: "n-5s",
        actions: ["Check", "Bet 75"],
        frequencies: [0, 1],
        player: 1,
      },
    ];
    const ranked = filterAndSortLineCardRows(rows, {
      board,
      street: "river",
      predicate: { suits: ["h"], excludeBoardPair: true },
      actionIndex: 1,
      sortBy: "frequency",
      sortDirection: "desc",
    });
    expect(ranked.map((row) => row.card)).toEqual(["5h", "9h"]);
    const filtered = withLineCardReportFilter(
      {
        pending: false,
        reportNodeId: "n",
        line: "root",
        street: "river",
        chanceNodeId: "chance",
        actionLabels: ["Check", "Bet 75"],
        rows,
        solutionId: "sol",
      },
      {
        predicate: { suits: ["h"], excludeBoardPair: true },
        board,
        actionIndex: 1,
        actionLabel: "Bet 75",
        sortBy: "frequency",
        sortDirection: "desc",
        seat: "IP",
      },
    );
    expect(filtered.matchedCards).toEqual(["5h", "9h"]);
  });
});
