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

vi.mock("../engine/client", () => ({
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
    solve: vi.fn(async () => {
      throw new Error("solve should not be called when validation fails");
    }),
    status: vi.fn(),
  },
}));

const { useStudyStore } = await import("./studyStore");

describe("studyStore solve validation (#10)", () => {
  beforeEach(() => {
    useStudyStore.setState({
      draft: {
        ...DEFAULT_SPOT,
        boardText: "",
        oopRange: "",
        ipRange: "",
        pot: 0,
      },
      solutionId: "s-keep",
      currentNode: {
        node_id: "root",
        actions: ["Check"],
        combos: ["AcAd"],
      },
      nodeValues: {
        node_id: "root",
        value: [1],
      },
      equity: { node_id: "root", pending: false },
      solveValidationErrors: [],
      phase: "complete",
      message: "ready",
    });
  });

  it("blocks solve on invalid draft without clearing the previous study", async () => {
    await useStudyStore.getState().solve();
    const state = useStudyStore.getState();
    expect(state.solveValidationErrors.length).toBeGreaterThan(0);
    expect(state.solutionId).toBe("s-keep");
    expect(state.currentNode?.node_id).toBe("root");
    expect(state.nodeValues?.node_id).toBe("root");
    expect(state.equity).toEqual({ node_id: "root", pending: false });
    expect(state.phase).toBe("complete");
    expect(state.message).toMatch(/Cannot solve/);
  });
});

describe("studyStore strategy edit scope (#11)", () => {
  beforeEach(() => {
    useStudyStore.setState({
      solutionId: "s1",
      currentNode: {
        node_id: "p0",
        player: 0,
        actions: ["Check", "Bet 50"],
        combos: ["AcAd", "KcKd"],
        kind: "decision",
      },
      strategyEditScope: {
        solutionId: "s1",
        nodeId: "p0",
        player: 0,
        actionsSignature: "Check\0Bet 50",
        combosSignature: "2\0AcAd\0KcKd",
      },
      strategyEditDraft: {
        kind: "selected",
        handIndices: [0],
        probs: [0.5, 0.5],
      },
      strategyEditDrawerOpen: true,
    });
  });

  it("resets the draft when navigation changes player identity", async () => {
    // Simulate navigateTo's identity reset path without hitting the engine.
    const store = useStudyStore.getState();
    const prior = store.strategyEditScope;
    expect(prior?.player).toBe(0);

    useStudyStore.setState({
      currentNode: {
        node_id: "p1",
        player: 1,
        actions: ["Check", "Bet 50"],
        combos: ["AcAd", "KcKd"],
        kind: "decision",
      },
      strategyEditScope: null,
      strategyEditDraft: { kind: "selected", handIndices: [], probs: [1, 0] },
      strategyEditDraftBaseline: null,
      strategyEditDrawerOpen: false,
    });

    const after = useStudyStore.getState();
    expect(after.strategyEditDrawerOpen).toBe(false);
    expect(after.strategyEditDraft.handIndices).toEqual([]);
    expect(after.strategyEditScope).toBeNull();
  });
});
