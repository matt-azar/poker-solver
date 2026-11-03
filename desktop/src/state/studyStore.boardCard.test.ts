import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SPOT } from "../domain/types";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  }),
});

const engineMocks = vi.hoisted(() => {
  let getNodeImpl: (
    solutionId: string,
    nodeId: string,
  ) => Promise<Record<string, unknown>> = async (solutionId, nodeId) => ({
    node_id: nodeId,
    solution_id: solutionId,
    kind: "decision",
  });

  return {
    setGetNodeImpl(impl: typeof getNodeImpl) {
      getNodeImpl = impl;
    },
    EngineError: class EngineError extends Error {
      status: number;
      body: unknown;
      constructor(message: string, status = 400, body: unknown = null) {
        super(message);
        this.status = status;
        this.body = body;
      }
    },
    engineClient: {
      status: vi.fn(async () => ({
        running: false,
        solution_id: "s1",
        root_node_id: "p0.t-1.r-1",
        status_generation: 1,
      })),
      getNode: vi.fn(async (solutionId: string, nodeId: string) =>
        getNodeImpl(solutionId, nodeId),
      ),
      pause: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      solve: vi.fn(async () => undefined),
      open: vi.fn(async () => undefined),
    },
  };
});

vi.mock("../engine/client", () => ({
  EngineError: engineMocks.EngineError,
  engineClient: engineMocks.engineClient,
}));

const { useStudyStore } = await import("./studyStore");

const turnDeal = {
  node_id: "p2.t-1.r-1",
  solution_id: "s1",
  kind: "chance",
  board: ["Ah", "Kd", "7c"],
  place: "deal turn",
  parent_id: "p1.t-1.r-1",
  cards: [{ card: "2s", child_id: "p4.t15.r-1", weight: 0.02 }],
  children: [],
};

describe("studyStore board card change", () => {
  beforeEach(() => {
    engineMocks.engineClient.getNode.mockClear();
    engineMocks.setGetNodeImpl(async (solutionId, nodeId) => ({
      node_id: nodeId,
      solution_id: solutionId,
      kind: "decision",
      board: ["Ah", "Kd", "7c", "2s"],
    }));
    useStudyStore.setState({
      draft: { ...DEFAULT_SPOT, boardText: "Ah Kd 7c 2s" },
      solutionId: "s1",
      currentNode: {
        node_id: "p8.t15.r-1",
        solution_id: "s1",
        kind: "decision",
        board: ["Ah", "Kd", "7c", "2s"],
        parent_id: "p4.t15.r-1",
        actions: ["Check"],
      },
      pathTrail: [
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
          nodeId: "p2.t-1.r-1",
          label: "Check",
          rawLabel: "Check",
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
          parentId: "p0.t-1.r-1",
        },
        {
          kind: "action",
          nodeId: "p8.t15.r-1",
          label: "Check",
          rawLabel: "Check",
          street: "turn",
          actor: "OOP",
        },
      ],
      boardChangeChanceNode: null,
      boardChangeStreet: null,
      status: {
        running: false,
        solution_id: "s1",
        root_node_id: "p0.t-1.r-1",
        status_generation: 1,
      },
      phase: "complete",
      message: "ready",
      navHistory: [],
      navHistoryIndex: -1,
      canNavBack: false,
      canNavForward: false,
    });
  });

  it("arms the deal-chance ancestor from pathTrail without navigating away", async () => {
    engineMocks.setGetNodeImpl(async (solutionId, nodeId) => {
      if (nodeId === "p2.t-1.r-1") {
        return { ...turnDeal, solution_id: solutionId };
      }
      return {
        node_id: nodeId,
        solution_id: solutionId,
        kind: "decision",
        board: ["Ah", "Kd", "7c", "2s"],
      };
    });

    const beforeId = useStudyStore.getState().currentNode?.node_id;
    const result = await useStudyStore.getState().prepareBoardCardChange("turn");
    expect(result).toEqual({
      ok: true,
      street: "turn",
      chanceNodeId: "p2.t-1.r-1",
    });
    expect(useStudyStore.getState().currentNode?.node_id).toBe(beforeId);
    expect(useStudyStore.getState().boardChangeChanceNode?.node_id).toBe("p2.t-1.r-1");
    expect(useStudyStore.getState().boardChangeStreet).toBe("turn");
    expect(engineMocks.engineClient.getNode).toHaveBeenCalledWith("s1", "p2.t-1.r-1");
  });

  it("rewrites current .t/.r on select and falls back to chance child on 404", async () => {
    useStudyStore.setState({
      boardChangeChanceNode: turnDeal as never,
      boardChangeStreet: "turn",
      currentNode: {
        node_id: "p8.t15.r-1",
        solution_id: "s1",
        kind: "decision",
        board: ["Ah", "Kd", "7c", "2s"],
        parent_id: "p4.t15.r-1",
      },
    });

    const seen: string[] = [];
    engineMocks.setGetNodeImpl(async (solutionId, nodeId) => {
      seen.push(nodeId);
      if (nodeId === "p8.t40.r-1") {
        throw new engineMocks.EngineError("unknown node", 404);
      }
      return {
        node_id: nodeId,
        solution_id: solutionId,
        kind: "decision",
        board: ["Ah", "Kd", "7c", "As"],
        parent_id: "p2.t-1.r-1",
        status_generation: 1,
      };
    });

    await useStudyStore.getState().selectBoardCard("p4.t40.r-1");
    // Probe rewritten p8.t40.r-1 → 404, then navigate to chance child p4.t40.r-1.
    expect(seen[0]).toBe("p8.t40.r-1");
    expect(seen).toContain("p4.t40.r-1");
    expect(useStudyStore.getState().currentNode?.node_id).toBe("p4.t40.r-1");
    expect(useStudyStore.getState().boardChangeChanceNode).toBeNull();
  });
});
