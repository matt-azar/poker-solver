import { describe, expect, it, vi } from "vitest";
import { fetchPostCallEquityHands } from "./valueBluffsPostCall";
import type { NodePayload } from "./types";

function decision(
  partial: Partial<NodePayload> & Pick<NodePayload, "combos" | "actions" | "strategy">,
): NodePayload {
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

const facingBetNode = decision({
  node_id: "p2.t11.r-1",
  actions: ["Check", "Bet 50"],
  combos: ["AhKd", "2c2d"],
  strategy: [
    [0.2, 0.8],
    [0.9, 0.1],
  ],
  children: ["c0", "c1"],
});

describe("fetchPostCallEquityHands host prefer path", () => {
  it("uses value_bluffs_post_call when deps expose it", async () => {
    const getValueBluffsPostCall = vi.fn(async () => ({
      pending: false,
      kind: "value_bluffs_post_call",
      hands: [
        { combo: "AhKd", equity: 0.61, weight: 1 },
        { combo: "2c2d", equity: 0.42, weight: 1 },
      ],
      hands_by_action: [
        {
          action_index: 1,
          hands: [
            { combo: "AhKd", equity: 0.61, weight: 1 },
            { combo: "2c2d", equity: 0.42, weight: 1 },
          ],
        },
      ],
      call_node_ids: ["call-1"],
      missing_call_count: 0,
    }));
    const getNode = vi.fn();
    const getEquity = vi.fn();
    const result = await fetchPostCallEquityHands({
      solutionId: "s1",
      node: facingBetNode,
      heroPlayer: 0,
      deps: { getNode, getEquity, getValueBluffsPostCall },
    });
    expect(getValueBluffsPostCall).toHaveBeenCalledWith("s1", "p2.t11.r-1", {
      minBetFreq: expect.any(Number),
      signal: undefined,
    });
    expect(getNode).not.toHaveBeenCalled();
    expect(getEquity).not.toHaveBeenCalled();
    expect(result.hands).toHaveLength(2);
    expect(result.hands[0]?.equity).toBeCloseTo(0.61, 12);
    expect(result.callNodeIds).toEqual(["call-1"]);
    expect(result.handsByBetAction.get(1)?.[0]?.equity).toBeCloseTo(0.61, 12);
  });

  it("falls back to multi-getNode when host op throws", async () => {
    const getValueBluffsPostCall = vi.fn(async () => {
      throw new Error("ipc unavailable");
    });
    const getNode = vi.fn(async () =>
      decision({
        node_id: "facing",
        actions: ["Fold", "Call"],
        combos: ["AhKd"],
        strategy: [[0.3, 0.7]],
        children: ["fold", "call-node"],
      }),
    );
    const getEquity = vi.fn(async () => ({
      pending: false,
      oop_hands: [
        { combo: "AhKd", equity: 0.55, weight: 1 },
        { combo: "2c2d", equity: 0.4, weight: 1 },
      ],
      ip_hands: [],
    }));
    const result = await fetchPostCallEquityHands({
      solutionId: "s1",
      node: facingBetNode,
      heroPlayer: 0,
      deps: { getNode, getEquity, getValueBluffsPostCall },
    });
    expect(getValueBluffsPostCall).toHaveBeenCalled();
    expect(getNode).toHaveBeenCalled();
    expect(result.hands.length).toBeGreaterThan(0);
  });
});
