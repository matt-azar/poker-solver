import { describe, expect, it, vi } from "vitest";
import type { ActionValuesPayload, NodePayload } from "../types";
import type { LineCardReportActiveFilter, LineCardReportModel } from "../lineCardReport";
import {
  compareRunouts,
  findSeatDecisionNodeId,
  listBluffCandidates,
  looksLikeCompareRunoutsRequest,
  looksLikeStudyEvidenceRequest,
  queryNodeStrategy,
  querySelectedHandAnalysis,
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
    combos: ["AsAh", "AhAs", "AdAs", "AcAs"],
    reach: [1, 1, 1, 1],
    marginal: [1, 1, 1, 1],
    reach_defined: true,
    strategy: [
      [0.6, 0.4],
      [0.5, 0.5],
      [0.55, 0.45],
      [0.4, 0.6],
    ],
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

function riverIpNode(partial: Partial<NodePayload> = {}): NodePayload {
  return ipNode({
    node_id: "ip-river",
    line: "root/Check/As",
    board: ["Ah", "Kd", "7c", "2s", "3d"],
    actions: ["Check", "Bet 75"],
    strategy: [
      [0.2, 0.8],
      [0.4, 0.6],
      [0.7, 0.3],
    ],
    ...partial,
  });
}

function makeHost(initial: {
  node: NodePayload;
  nodes?: Record<string, NodePayload>;
  equityReady?: boolean;
  selectedCell?: { text: string } | null;
  lineCardReport?: LineCardReportModel | null;
}): {
  host: StudyEvidenceHost;
  state: StudyEvidenceLiveState;
  lineCardReport: { current: LineCardReportModel | null };
} {
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
          oop_hands: [
            { combo: "AsAh", equity: 0.4, weight: 1 },
            { combo: "AhAs", equity: 0.41, weight: 1 },
            { combo: "AdAs", equity: 0.39, weight: 1 },
            { combo: "AcAs", equity: 0.38, weight: 1 },
          ],
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
    selectedCell: initial.selectedCell ?? null,
    evDisplayBasis: "local",
    status: { solution_id: "sol-1", nash_gap: 0.01 },
  };

  const lineCardReport = {
    current: initial.lineCardReport ?? null,
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
    loadLineCardReport: vi.fn(async (opts?: { filter?: LineCardReportActiveFilter | null }) => {
      lineCardReport.current = {
        pending: false,
        reportNodeId: state.currentNode!.node_id,
        line: String(state.currentNode?.line ?? state.currentNode!.node_id),
        street: "river",
        chanceNodeId: "chance-river",
        actionLabels: [...(state.currentNode?.actions ?? [])],
        solutionId: state.solutionId ?? undefined,
        rows: [
          {
            card: "5h",
            dealProbability: 0.02,
            dealProbabilityDefined: true,
            reach: 0.1,
            reachDefined: true,
            zeroReach: false,
            available: true,
            reason: null,
            resolvedNodeId: "ip-river-5h",
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
            resolvedNodeId: "ip-river-9h",
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
            resolvedNodeId: "ip-river-Ah",
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
            resolvedNodeId: "ip-river-5s",
            actions: ["Check", "Bet 75"],
            frequencies: [0, 1],
            player: 1,
          },
        ],
        activeFilter: opts?.filter ?? null,
        matchedCards: opts?.filter
          ? ["5h", "9h"]
          : undefined,
      };
    }),
    applyLineCardReportFilter: vi.fn((filter) => {
      if (!lineCardReport.current) return;
      lineCardReport.current = {
        ...lineCardReport.current,
        activeFilter: filter,
        matchedCards: filter ? ["5h", "9h"] : undefined,
      };
    }),
    openLineCardRow: vi.fn(async () => undefined),
    readLineCardReport: () => lineCardReport.current,
  };
  return { host, state, lineCardReport };
}

describe("looksLikeStudyEvidenceRequest", () => {
  it("detects bluff and strategy questions", () => {
    expect(looksLikeStudyEvidenceRequest("What are the bluffs for IP in the current node?")).toBe(
      true,
    );
    expect(looksLikeStudyEvidenceRequest("At this 3BP node, which hands bluff?")).toBe(true);
    expect(looksLikeStudyEvidenceRequest("How often does OOP bet here?")).toBe(true);
    expect(looksLikeStudyEvidenceRequest("Set pot to 55")).toBe(false);
  });

  it("detects compare-runouts filter phrasing", () => {
    expect(
      looksLikeCompareRunoutsRequest(
        "On this line, show the heart rivers that don't pair the board, ranked by IP's 75% bet frequency.",
      ),
    ).toBe(true);
    expect(
      looksLikeStudyEvidenceRequest(
        "Show heart rivers that don't pair the board ranked by IP's 75% bet",
      ),
    ).toBe(true);
  });
});

describe("compareRunouts", () => {
  it("opens Compare runouts with heart non-pairing rivers ranked by 75% frequency", async () => {
    const { host } = makeHost({ node: riverIpNode() });
    const evidence = await compareRunouts(host, {
      seat: "IP",
      street: "river",
      suits: ["h"],
      excludeBoardPair: true,
      action: "75%",
      sortBy: "frequency",
    });
    expect(evidence.ok).toBe(true);
    expect(evidence.openedReport).toBe(true);
    expect(evidence.filters.action).toBe("Bet 75");
    expect(evidence.rows.map((row) => row.card)).toEqual(["5h", "9h"]);
    expect(evidence.rows[0]?.frequency).toBeCloseTo(0.8, 8);
    expect(evidence.openInStudy?.card).toBe("5h");
    expect(host.loadLineCardReport).toHaveBeenCalled();
  });

  it("rejects an unavailable size with supported actions", async () => {
    const { host } = makeHost({ node: riverIpNode() });
    const evidence = await compareRunouts(host, {
      seat: "IP",
      action: "33%",
      suits: ["h"],
    });
    expect(evidence.ok).toBe(false);
    expect(evidence.absences.join(" ")).toMatch(/not available/i);
    expect(evidence.supportedActions).toEqual(["Check", "Bet 75"]);
    expect(host.loadLineCardReport).not.toHaveBeenCalled();
  });

  it("hints when the requested seat is not acting", async () => {
    const { host, state } = makeHost({
      node: oopRoot(),
      nodes: { "ip-1": riverIpNode() },
    });
    const evidence = await compareRunouts(host, {
      seat: "IP",
      action: "75%",
    });
    expect(evidence.ok).toBe(false);
    expect(evidence.absences.join(" ")).toMatch(/not IP/i);
    expect(state.currentNode?.node_id).toBe("root");
    expect(host.loadLineCardReport).not.toHaveBeenCalled();
  });

  it("opens a matched card through openLineCardRow", async () => {
    const { host } = makeHost({ node: riverIpNode() });
    const evidence = await compareRunouts(host, {
      seat: "IP",
      suits: ["h"],
      excludeBoardPair: true,
      action: "Bet 75",
      openCard: "9h",
    });
    expect(evidence.ok).toBe(true);
    expect(evidence.openedCard).toBe("9h");
    expect(host.openLineCardRow).toHaveBeenCalledWith("ip-river-9h");
  });

  it("aborts when the solution changes while loading the report", async () => {
    const { host, state } = makeHost({ node: riverIpNode() });
    host.loadLineCardReport = vi.fn(async () => {
      state.solutionId = "sol-other";
    });
    const evidence = await compareRunouts(host, {
      seat: "IP",
      action: "75%",
      suits: ["h"],
      excludeBoardPair: true,
    });
    expect(evidence.ok).toBe(false);
    expect(evidence.absences.join(" ")).toMatch(/changed while building/i);
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

  it("does not navigate when asked for the other seat — preserves selection", async () => {
    const ip = ipNode();
    const { host, state } = makeHost({
      node: oopRoot(),
      nodes: { "ip-1": ip, "ip-face-bet": ipNode({ node_id: "ip-face-bet" }) },
    });
    const found = await findSeatDecisionNodeId(host, "IP");
    expect(found).toEqual(
      expect.objectContaining({ nodeId: "ip-1", hops: 1 }),
    );
    const evidence = await queryNodeStrategy(host, { seat: "IP" });
    expect(evidence.ok).toBe(false);
    expect(evidence.navigated).toBe(false);
    expect(evidence.absences.join(" ")).toMatch(/Open the intended IP decision/i);
    expect(host.navigateTo).not.toHaveBeenCalled();
    expect(state.currentNode?.node_id).toBe("root");
  });

  it("asks the player to open a mismatched bet-size branch instead of hopping", async () => {
    const { host, state } = makeHost({
      node: ipNode({
        node_id: "ip-33",
        line: "root/Bet 33",
        to_call: 18,
        actions: ["Fold", "Call", "Raise 75"],
      }),
    });
    const evidence = await queryNodeStrategy(host, { seat: "OOP" });
    expect(evidence.ok).toBe(false);
    expect(state.currentNode?.node_id).toBe("ip-33");
    expect(host.navigateTo).not.toHaveBeenCalled();
    expect(evidence.absences.join(" ")).toMatch(/not OOP/i);
  });
});

describe("listBluffCandidates", () => {
  it("lists low-equity betting hands for IP with filter metadata", async () => {
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
    expect(evidence.equityMode).toBe("node");
    expect(evidence.minBetFreq).toBeGreaterThan(0);
    expect(evidence.minReach).toBeGreaterThan(0);
    expect(evidence.absences.join(" ")).toMatch(/After-call/i);
  });
});

describe("querySelectedHandAnalysis", () => {
  it("returns action-level EV for the selected matrix class", async () => {
    const { host } = makeHost({
      node: oopRoot(),
      equityReady: true,
      selectedCell: { text: "AA" },
    });
    const evidence = await querySelectedHandAnalysis(host);
    expect(evidence.label).toBe("AA");
    expect(evidence.strategy?.length).toBe(2);
    expect(evidence.mixedEv).not.toBeNull();
    expect(evidence.actionEv?.map((row) => row.action)).toEqual(["Check", "Bet 33"]);
    expect(evidence.actionEv?.every((row) => Number.isFinite(row.ev))).toBe(true);
  });

  it("discards numbers when the player navigates during the evidence wait", async () => {
    const { host, state } = makeHost({
      node: ipNode(),
      equityReady: true,
      selectedCell: { text: "AA" },
    });
    host.ensureNodeAnalysis = vi.fn(async () => {
      state.currentNode = ipNode({ node_id: "other-node" });
    });
    const evidence = await querySelectedHandAnalysis(host);
    expect(evidence.ok).toBe(false);
    expect(evidence.mixedEv).toBeNull();
    expect(evidence.actionEv).toBeNull();
    expect(evidence.absences.join(" ")).toMatch(/Retry on the intended decision/i);
  });
});
