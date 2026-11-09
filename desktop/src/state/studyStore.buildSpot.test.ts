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

const engineMocks = vi.hoisted(() => ({
  EngineError: class EngineError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.status = status;
    }
  },
  engineClient: {
    getSolutionConfig: vi.fn(async () => ({
      oop_turn_bets: [0.5],
      ip_turn_bets: [0.5],
      oop_river_bets: [0.75],
      ip_river_bets: [0.75],
      oop_turn_donk: [0.33],
      max_raises: 1,
    })),
    treePreview: vi.fn(async () => ({
      nodes: [
        {
          index: 0,
          terminal: false,
          chance: false,
          player: 0,
          street: 1,
          path: "",
          chance_child: -1,
          actions: [
            { label: "Check", compact: "c", child_index: 1 },
            { label: "Bet 75", compact: "b75", child_index: 2 },
          ],
          children: [1, 2],
        },
      ],
      tree_edits: [],
      plan: {
        estimated_peak_bytes: 1,
        memory_budget_bytes: 1,
        deals: 0,
        infosets: 0,
        decision_nodes: 0,
        terminals: 0,
        public_decisions: 1,
        threads: 1,
        fits_budget: true,
        dry_run: true,
      },
    })),
  },
}));

vi.mock("../engine/client", () => ({
  EngineError: engineMocks.EngineError,
  engineClient: engineMocks.engineClient,
}));

const { useStudyStore } = await import("./studyStore");

describe("createBuildSpotFromHere", () => {
  beforeEach(() => {
    engineMocks.engineClient.getSolutionConfig.mockClear();
    engineMocks.engineClient.treePreview.mockClear();
    useStudyStore.setState({
      draft: { ...DEFAULT_SPOT, iterations: 250, threads: 4 },
      solutionId: "s9",
      workspace: "study",
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
      currentNode: {
        node_id: "p8.t15.r-1",
        kind: "decision",
        player: 0,
        pot: 140,
        stack: 160,
        contrib: [0, 0],
        to_call: 0,
        board: ["Ah", "Kd", "7c", "2s"],
        line: "Check/Bet 50/Call",
        actions: ["Check", "Bet 75"],
        combos: ["AsAd", "KsKh"],
        reach: [0.6, 0.2],
        opponent_combos: ["QsQh", "JsJh"],
        opponent_reach: [0.5, 0.1],
      },
      message: "",
      setupMeta: null,
    });
  });

  it("replaces the Build draft and opens Build for review", async () => {
    await useStudyStore.getState().createBuildSpotFromHere();
    const state = useStudyStore.getState();
    expect(state.workspace).toBe("build");
    expect(state.draft.boardText).toBe("Ah Kd 7c 2s");
    expect(state.draft.pot).toBe(140);
    expect(state.draft.stack).toBe(160);
    expect(state.draft.oopRange).toContain("AsAd");
    expect(state.draft.ipRange).toContain("QsQh");
    expect(state.draft.iterations).toBe(250);
    expect(state.draft.treeEdits).toEqual([]);
    expect(state.setupMeta?.provenance.oopRange).toBe("derived");
    expect(state.message).toMatch(/Root actions match|Build spot|Extracted/);
    expect(engineMocks.engineClient.treePreview).toHaveBeenCalled();
  });

  it("leaves the Study solution intact when the node is ineligible", async () => {
    useStudyStore.setState({
      currentNode: {
        ...useStudyStore.getState().currentNode!,
        player: 1,
      },
      workspace: "study",
      solutionId: "s9",
    });
    await useStudyStore.getState().createBuildSpotFromHere();
    expect(useStudyStore.getState().workspace).toBe("study");
    expect(useStudyStore.getState().solutionId).toBe("s9");
    expect(useStudyStore.getState().message).toMatch(/OOP/);
  });
});
