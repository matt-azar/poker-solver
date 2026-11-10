import { describe, expect, it } from "vitest";
import {
  aggregateActionFrequency,
  LINE_CARD_GRID_RANKS,
  lineCardEquityFromPayload,
  lineCardEvFromValues,
  lineCardReportStreet,
  lineCardTargetId,
  readNodeJoint,
  rowFromResolvedNode,
  unavailableRow,
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
