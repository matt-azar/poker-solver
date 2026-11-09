import { describe, expect, it } from "vitest";
import type { PathStep } from "../actionHistory";
import type { NodePayload, SpotDraft } from "../types";
import { DEFAULT_SPOT } from "../types";
import {
  compareRootActions,
  draftBuildSpotFromStudy,
  evaluateBuildSpotEligibility,
  priorStreetIpAggression,
} from "./transferFromStudy";

function streetStartNode(partial: Partial<NodePayload> = {}): NodePayload {
  return {
    node_id: "p8.t15.r-1",
    kind: "decision",
    player: 0,
    pot: 150,
    stack: 175,
    stacks: [175, 180],
    contrib: [0, 0],
    to_call: 0,
    board: ["Ah", "Kd", "7c", "2s"],
    line: "Check/Bet 50/Call",
    actions: ["Check", "Bet 75"],
    combos: ["AsAd", "KsKh"],
    reach: [0.4, 0.1],
    opponent_combos: ["QsQh", "JsJh"],
    opponent_reach: [0.5, 0.2],
    reach_defined: true,
    ...partial,
  };
}

describe("evaluateBuildSpotEligibility", () => {
  it("accepts OOP street-start turn and river decisions", () => {
    expect(evaluateBuildSpotEligibility(streetStartNode()).ok).toBe(true);
    expect(
      evaluateBuildSpotEligibility(
        streetStartNode({
          board: ["Ah", "Kd", "7c", "2s", "3h"],
          node_id: "p20.t15.r7",
        }),
      ),
    ).toEqual({ ok: true, street: "river" });
  });

  it("rejects flop-only, midstreet, and IP-to-act nodes", () => {
    expect(
      evaluateBuildSpotEligibility(
        streetStartNode({ board: ["Ah", "Kd", "7c"] }),
      ).ok,
    ).toBe(false);
    expect(
      evaluateBuildSpotEligibility(streetStartNode({ player: 1 })).ok,
    ).toBe(false);
    expect(
      evaluateBuildSpotEligibility(streetStartNode({ to_call: 50 })).ok,
    ).toBe(false);
    expect(
      evaluateBuildSpotEligibility(streetStartNode({ contrib: [0, 50] })).ok,
    ).toBe(false);
  });
});

describe("priorStreetIpAggression", () => {
  it("reads IP aggression from the path trail on the prior street", () => {
    const trail: PathStep[] = [
      {
        kind: "root",
        nodeId: "p0.t-1.r-1",
        label: "Root",
        rawLabel: "Root",
        street: "flop",
        actor: null,
      },
      {
        kind: "action",
        nodeId: "p1.t-1.r-1",
        label: "Check",
        rawLabel: "Check",
        street: "flop",
        actor: "OOP",
      },
      {
        kind: "action",
        nodeId: "p2.t-1.r-1",
        label: "b50",
        rawLabel: "Bet 50",
        street: "flop",
        actor: "IP",
      },
      {
        kind: "action",
        nodeId: "p3.t-1.r-1",
        label: "Call",
        rawLabel: "Call",
        street: "flop",
        actor: "OOP",
      },
      {
        kind: "card",
        nodeId: "p4.t15.r-1",
        label: "2s",
        rawLabel: "2s",
        street: "turn",
        actor: null,
        card: "2s",
      },
    ];
    expect(priorStreetIpAggression("turn", trail, "")).toBe(true);
    expect(
      priorStreetIpAggression(
        "turn",
        trail.filter((step) => step.actor !== "IP"),
        "",
      ),
    ).toBe(false);
  });

  it("falls back to Bet/Call patterns in the line when trail is missing", () => {
    expect(priorStreetIpAggression("turn", null, "Check/Bet 50/Call")).toBe(
      true,
    );
    expect(priorStreetIpAggression("turn", null, "Check/Check")).toBe(false);
  });
});

describe("draftBuildSpotFromStudy", () => {
  it("builds a draft from raw reaches, pot, and effective stack", () => {
    const result = draftBuildSpotFromStudy({
      node: streetStartNode(),
      solutionId: "s1",
      config: {
        oop_turn_bets: [0.5],
        ip_turn_bets: [0.5],
        oop_river_bets: [0.75],
        ip_river_bets: [0.75],
        oop_turn_donk: [0.33],
        max_raises: 1,
        pot: 100,
        stack: 200,
      },
      prefsDraft: { ...DEFAULT_SPOT, iterations: 333, threads: 2 },
      pathTrail: [
        {
          kind: "action",
          nodeId: "p2.t-1.r-1",
          label: "b50",
          rawLabel: "Bet 50",
          street: "flop",
          actor: "IP",
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.draft.boardText).toBe("Ah Kd 7c 2s");
    expect(result.draft.pot).toBe(150);
    expect(result.draft.stack).toBe(175);
    expect(result.draft.oopRange).toContain("AsAd");
    expect(result.draft.ipRange).toContain("QsQh");
    expect(result.draft.iterations).toBe(333);
    expect(result.draft.threads).toBe(2);
    expect(result.draft.treeEdits).toEqual([]);
    expect(result.draft.oopFlop).toBe("");
    expect(result.donkBaked).toBe(true);
    expect(result.draft.oopTurn).toMatch(/0\.33|33/);
    expect(result.draft.oopTurnDonk).toBe("");
    expect(result.meta.canSolve).toBe(true);
    expect(result.meta.provenance.pot).toBe("derived");
  });

  it("does not use posterior marginals for ranges", () => {
    const result = draftBuildSpotFromStudy({
      node: streetStartNode({
        marginal: [1, 1],
        opponent_marginal: [1, 1],
        reach: [0.25, 0],
        opponent_reach: [0.5, 0],
      }),
      solutionId: "s1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.draft.oopRange).toContain("AsAd");
    expect(result.draft.oopRange).not.toContain("KsKh");
  });

  it("clears past-street sizes on a river extraction", () => {
    const result = draftBuildSpotFromStudy({
      node: streetStartNode({
        board: ["Ah", "Kd", "7c", "2s", "9h"],
        node_id: "p30.t15.r20",
        line: "Check/Bet 50/Call/Check/Check",
      }),
      solutionId: "s1",
      config: {
        oop_turn_bets: [0.5],
        oop_river_bets: [1],
        ip_river_bets: [1],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.source.street).toBe("river");
    expect(result.draft.oopTurn).toBe("");
    expect(result.draft.oopRiver.length).toBeGreaterThan(0);
  });
});

describe("compareRootActions", () => {
  it("reports missing and extra labels", () => {
    expect(compareRootActions(["Check", "Bet 50"], ["Check", "Bet 50"])).toEqual(
      {
        match: true,
        missing: [],
        extra: [],
      },
    );
    expect(compareRootActions(["Check", "Bet 50"], ["Check", "Bet 75"])).toEqual(
      {
        match: false,
        missing: ["Bet 50"],
        extra: ["Bet 75"],
      },
    );
  });
});

describe("prefsDraft typing smoke", () => {
  it("accepts a SpotDraft prefs bag", () => {
    const prefs: SpotDraft = { ...DEFAULT_SPOT, iterations: 10 };
    const result = draftBuildSpotFromStudy({
      node: streetStartNode(),
      solutionId: "s1",
      prefsDraft: prefs,
    });
    expect(result.ok).toBe(true);
  });
});
