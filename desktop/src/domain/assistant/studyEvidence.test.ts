import { describe, expect, it, vi } from "vitest";
import type { ActionValuesPayload, NodePayload } from "../types";
import {
  findSeatDecisionNodeId,
  listBluffCandidates,
  looksLikeStudyEvidenceRequest,
  queryNodeStrategy,
  type StudyEvidenceHost,
  type StudyEvidenceLiveState,
} from "./studyEvidence";

function ipNode(partial: Partial<NodePayload> = {}): NodePayload {
  return {
    node_id: "ip-1",
    kind: "decision",
    player: 1,
    to_act: "IP",
    line: "root/Check",
    actions: ["Check", "Bet 50"],
    children: ["term-check", "oop-face"],
    combos: ["AsAh", "7h2d", "KhKd"],
    reach: [1, 1, 1],
    marginal: [1, 1, 1],
    reach_defined: true,
    strategy: [
      [0.9, 0.1],
      [0.2, 0.8],
      [0.7, 0.3],
    ],
    pot: 55,
    stacks: [97.5, 97.5],
    to_call: 0,
    ...partial,
  };
}

function oopRoot(): NodePayload {
  return {
    node_id: "root",
    kind: "decision",
    player: 0,
    to_act: "OOP",
    line: "root",
    actions: ["Check", "Bet 33"],
    children: ["ip-1", "ip-face-bet"],
    combos: ["AsAh"],
    reach: [1],
    marginal: [1],
    reach_defined: true,
    strategy: [[0.6, 0.4]],
  };
}

function valuesFor(node: NodePayload): ActionValuesPayload {
  return {
    pending: false,
    node_id: node.node_id,
    solution_id: "sol-1",
    combos: [...(node.combos ?? [])],
    value: (node.combos ?? []).map((_, index) => 1 - index * 0.2),
    action_ev: (node.combos ?? []).map(() => [0.5, 1.2]),
    ev_defined: (node.combos ?? []).map(() => true),
    utility_basis: "root_centered",
    local_offset: 0,
  };
}

function makeHost(initial: {
  node: NodePayload;
  nodes?: Record<string, NodePayload>;
  equityReady?: boolean;
}): { host: StudyEvidenceHost; state: StudyEvidenceLiveState } {
  const nodes = {
    [initial.node.node_id]: initial.node,
    ...(initial.nodes ?? {}),
  };
  const state: StudyEvidenceLiveState = {
    solutionId: "sol-1",
    currentNode: initial.node,
    nodeValues: valuesFor(initial.node),
    equity: initial.equityReady
      ? {
          pending: false,
          node_id: initial.node.node_id,
          solution_id: "sol-1",
          ip_hands: [
            { combo: "AsAh", equity: 0.72, weight: 1 },
            { combo: "7h2d", equity: 0.12, weight: 1 },
            { combo: "KhKd", equity: 0.55, weight: 1 },
          ],
          oop_hands: [{ combo: "AsAh", equity: 0.4, weight: 1 }],
        }
      : {
          pending: false,
          node_id: initial.node.node_id,
          solution_id: "sol-1",
          ip_hands: [
            { combo: "AsAh", equity: 0.72, weight: 1 },
            { combo: "7h2d", equity: 0.12, weight: 1 },
            { combo: "KhKd", equity: 0.55, weight: 1 },
          ],
          oop_hands: [{ combo: "AsAh", equity: 0.4, weight: 1 }],
        },
    pathTrail: [
      { nodeId: "root", label: "Root", rawLabel: "Root", kind: "root", street: "flop", actor: null },
    ],
    selectedCell: null,
    evDisplayBasis: "local",
    status: { solution_id: "sol-1", nash_gap: 0.01 },
  };

  const host: StudyEvidenceHost = {
    read: () => state,
    ensureNodeAnalysis: vi.fn(async () => undefined),
    navigateTo: vi.fn(async (nodeId: string) => {
      const next = nodes[nodeId];
      if (!next) {
        throw new Error(`missing ${nodeId}`);
      }
      state.currentNode = next;
      state.nodeValues = valuesFor(next);
      state.equity = {
        ...(state.equity ?? {}),
        pending: false,
        node_id: next.node_id,
        solution_id: "sol-1",
      };
    }),
    fetchNode: vi.fn(async (nodeId: string) => {
      const next = nodes[nodeId];
      if (!next) {
        throw new Error(`missing ${nodeId}`);
      }
      return next;
    }),
  };
  return { host, state };
}

describe("looksLikeStudyEvidenceRequest", () => {
  it("detects bluff and strategy questions", () => {
    expect(looksLikeStudyEvidenceRequest("What are the bluffs for IP in the current node?")).toBe(
      true,
    );
    expect(looksLikeStudyEvidenceRequest("How often does OOP bet here?")).toBe(true);
    expect(looksLikeStudyEvidenceRequest("Set pot to 55")).toBe(false);
  });
});

describe("queryNodeStrategy", () => {
  it("returns the acting-seat mix at the current node", async () => {
    const { host } = makeHost({ node: ipNode() });
    const evidence = await queryNodeStrategy(host, { seat: "IP" });
    expect(evidence.ok).toBe(true);
    expect(evidence.seat).toBe("IP");
    expect(evidence.actions.map((row) => row.action)).toEqual(["Check", "Bet 50"]);
    expect(evidence.navigated).toBe(false);
  });

  it("hops from OOP root to IP child when asked for IP", async () => {
    const ip = ipNode();
    const { host } = makeHost({
      node: oopRoot(),
      nodes: { "ip-1": ip, "ip-face-bet": ipNode({ node_id: "ip-face-bet" }) },
    });
    const found = await findSeatDecisionNodeId(host, "IP");
    expect(found).toEqual({ nodeId: "ip-1", hops: 1 });
    const evidence = await queryNodeStrategy(host, { seat: "IP" });
    expect(evidence.ok).toBe(true);
    expect(evidence.navigated).toBe(true);
    expect(evidence.nodeId).toBe("ip-1");
    expect(host.navigateTo).toHaveBeenCalledWith("ip-1");
  });
});

describe("listBluffCandidates", () => {
  it("lists low-equity betting hands for IP", async () => {
    const { host } = makeHost({ node: ipNode(), equityReady: true });
    const evidence = await listBluffCandidates(host, {
      seat: "IP",
      equityThreshold: 0.3,
      limit: 10,
    });
    expect(evidence.ok).toBe(true);
    expect(evidence.rows.length).toBeGreaterThan(0);
    expect(evidence.rows.every((row) => row.equity < 0.3)).toBe(true);
    expect(evidence.rows[0]?.combo).toBe("7h2d");
  });
});
