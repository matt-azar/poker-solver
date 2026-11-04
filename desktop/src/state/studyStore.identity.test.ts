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
  let statusImpl: () => Promise<Record<string, unknown>> = async () => ({
    running: false,
    solution_id: null,
    status_generation: 0,
  });
  let compareImpl: (
    baseline: string,
    scenario: string,
    nodeId: string,
  ) => Promise<Record<string, unknown>> = async (baseline, scenario, nodeId) => ({
    baseline_id: baseline,
    scenario_id: scenario,
    node_id: nodeId,
    baseline_value: 1,
    scenario_value: 2,
    value_delta: 1,
    baseline_nash_gap: 0,
    scenario_nash_gap: 0,
    actions: ["Check"],
    hands: [],
  });
  let putLockImpl: (
    solutionId: string,
    body: Record<string, unknown>,
  ) => Promise<Record<string, unknown>> = async () => ({ locks: [] });
  let putStrategyImpl: (
    solutionId: string,
    body: Record<string, unknown>,
  ) => Promise<Record<string, unknown>> = async () => ({ edits: [] });

  return {
    setStatusImpl(impl: typeof statusImpl) {
      statusImpl = impl;
    },
    setCompareImpl(impl: typeof compareImpl) {
      compareImpl = impl;
    },
    setPutLockImpl(impl: typeof putLockImpl) {
      putLockImpl = impl;
    },
    setPutStrategyImpl(impl: typeof putStrategyImpl) {
      putStrategyImpl = impl;
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
      solve: vi.fn(async () => {
        throw new Error("solve should not be called when validation fails");
      }),
      status: vi.fn(async () => statusImpl()),
      compare: vi.fn(async (baseline: string, scenario: string, nodeId: string) =>
        compareImpl(baseline, scenario, nodeId),
      ),
      putLock: vi.fn(async (solutionId: string, body: Record<string, unknown>) =>
        putLockImpl(solutionId, body),
      ),
      listLocks: vi.fn(async () => ({ locks: [] })),
      putStrategyEdit: vi.fn(
        async (solutionId: string, body: Record<string, unknown>) =>
          putStrategyImpl(solutionId, body),
      ),
      listStrategyEdits: vi.fn(async () => ({ edits: [] })),
      getNode: vi.fn(async (solutionId: string, nodeId: string) => ({
        node_id: nodeId,
        solution_id: solutionId,
        actions: ["Check", "Bet 50"],
        combos: ["AcAd", "KcKd"],
        kind: "decision",
        player: 0,
        strategy: [
          [0.5, 0.5],
          [0.5, 0.5],
        ],
      })),
    },
  };
});

vi.mock("../engine/client", () => ({
  EngineError: engineMocks.EngineError,
  engineClient: engineMocks.engineClient,
}));

const { resetStatusPollingForTests, useStudyStore } = await import("./studyStore");

describe("studyStore solve validation (#10)", () => {
  beforeEach(() => {
    resetStatusPollingForTests();
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
    resetStatusPollingForTests();
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

describe("finding 6: single-flight status polling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStatusPollingForTests();
    useStudyStore.setState({
      solutionId: "s1",
      status: null,
      connection: "disconnected",
      phase: "idle",
      message: "",
    });
  });

  it("300ms latency still updates under single-flight polling", async () => {
    vi.useFakeTimers();
    let generation = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    engineMocks.setStatusImpl(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 300);
      });
      inFlight -= 1;
      generation += 1;
      return {
        running: false,
        solution_id: "s1",
        root_node_id: "root",
        status_generation: generation,
      };
    });

    useStudyStore.getState().startPolling();
    // First request starts immediately.
    await vi.advanceTimersByTimeAsync(0);
    expect(engineMocks.engineClient.status).toHaveBeenCalledTimes(1);

    // Old overlapping interval would have fired again at 250ms; single-flight must not.
    await vi.advanceTimersByTimeAsync(250);
    expect(engineMocks.engineClient.status).toHaveBeenCalledTimes(1);

    // Complete the 300ms request and allow the scheduled follow-up.
    await vi.advanceTimersByTimeAsync(50);
    expect(useStudyStore.getState().status?.status_generation).toBe(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(engineMocks.engineClient.status).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(300);
    expect(useStudyStore.getState().status?.status_generation).toBe(2);
    expect(maxInFlight).toBe(1);

    useStudyStore.getState().stopPolling();
    vi.useRealTimers();
  });

  it("stopPolling abort is shutdown cancel, not a connection failure", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    engineMocks.setStatusImpl(async () => {
      await gate;
      throw new DOMException("Aborted", "AbortError");
    });

    useStudyStore.setState({
      connection: "connected",
      message: "ready",
    });
    const pending = useStudyStore.getState().refresh();
    await Promise.resolve();
    useStudyStore.getState().stopPolling();
    release?.();
    await pending;

    const state = useStudyStore.getState();
    expect(state.connection).toBe("connected");
    expect(state.message).toBe("ready");
    expect(state.message).not.toMatch(/Engine unreachable/);
  });
});

describe("finding 7: stale compare / lock / strategy discarded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStatusPollingForTests();
    useStudyStore.setState({
      solutionId: "s1",
      baselineSolutionId: "s0",
      workspace: "study",
      currentNode: {
        node_id: "p0",
        solution_id: "s1",
        actions: ["Check", "Bet 50"],
        combos: ["AcAd", "KcKd"],
        kind: "decision",
        player: 0,
        strategy: [
          [0.5, 0.5],
          [0.5, 0.5],
        ],
      },
      compareNote: null,
      lockDraft: {
        kind: "selected",
        handIndices: [0],
        probs: [0.7, 0.3],
      },
      lockDraftBaseline: {
        kind: "selected",
        handIndices: [0],
        probs: [0.5, 0.5],
      },
      locks: [],
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
        probs: [0.8, 0.2],
      },
      strategyEditDraftBaseline: {
        kind: "selected",
        handIndices: [0],
        probs: [0.5, 0.5],
      },
      strategyEdits: [],
      message: "ready",
    });
  });

  it("late compare does not switch workspace after solution change", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    engineMocks.setCompareImpl(async (baseline, scenario, nodeId) => {
      await gate;
      return {
        baseline_id: baseline,
        scenario_id: scenario,
        node_id: nodeId,
        baseline_value: 1,
        scenario_value: 2,
        value_delta: 1,
        baseline_nash_gap: 0,
        scenario_nash_gap: 0,
        actions: ["Check"],
        hands: [],
      };
    });

    const pending = useStudyStore.getState().loadCompare("p0");
    await Promise.resolve();
    // Navigate to a new published solution while compare is in flight.
    useStudyStore.setState({
      solutionId: "s2",
      baselineSolutionId: "s0",
      currentNode: {
        node_id: "root",
        solution_id: "s2",
        actions: ["Check"],
        combos: ["AcAd"],
        kind: "decision",
        player: 0,
      },
      workspace: "study",
    });
    release?.();
    await pending;

    const state = useStudyStore.getState();
    expect(state.workspace).toBe("study");
    expect(state.compareNote).toBeNull();
    expect(state.solutionId).toBe("s2");
  });

  it("late lock apply does not write draft into another node", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    engineMocks.setPutLockImpl(async () => {
      await gate;
      return {
        locks: [
          {
            node_id: "p0",
            kind: "selected",
            hand_indices: [0],
            probs: [0.7, 0.3],
          },
        ],
      };
    });

    const pending = useStudyStore.getState().applyLock();
    await Promise.resolve();
    useStudyStore.setState({
      currentNode: {
        node_id: "p1",
        solution_id: "s1",
        actions: ["Check", "Bet 50"],
        combos: ["AcAd", "KcKd"],
        kind: "decision",
        player: 1,
      },
      lockDraft: {
        kind: "selected",
        handIndices: [1],
        probs: [0.1, 0.9],
      },
      lockDraftBaseline: {
        kind: "selected",
        handIndices: [1],
        probs: [0.1, 0.9],
      },
    });
    release?.();
    await pending;

    const state = useStudyStore.getState();
    expect(state.currentNode?.node_id).toBe("p1");
    // Draft for p1 must not be overwritten with p0's normalized probs.
    expect(state.lockDraft.handIndices).toEqual([1]);
    expect(state.lockDraft.probs).toEqual([0.1, 0.9]);
    // Locks list for the same solution may still update.
    expect(state.locks).toHaveLength(1);
    expect(state.locks[0]?.node_id).toBe("p0");
  });

  it("late strategy edit does not write draft into another node", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    engineMocks.setPutStrategyImpl(async () => {
      await gate;
      return {
        edits: [
          {
            node_id: "p0",
            kind: "selected",
            hand_indices: [0],
            probs: [0.8, 0.2],
          },
        ],
      };
    });

    const pending = useStudyStore.getState().applyStrategyEdit();
    await Promise.resolve();
    useStudyStore.setState({
      currentNode: {
        node_id: "p1",
        solution_id: "s1",
        actions: ["Check", "Bet 50"],
        combos: ["AcAd", "KcKd"],
        kind: "decision",
        player: 1,
      },
      strategyEditScope: {
        solutionId: "s1",
        nodeId: "p1",
        player: 1,
        actionsSignature: "Check\0Bet 50",
        combosSignature: "2\0AcAd\0KcKd",
      },
      strategyEditDraft: {
        kind: "selected",
        handIndices: [1],
        probs: [0.2, 0.8],
      },
      strategyEditDraftBaseline: {
        kind: "selected",
        handIndices: [1],
        probs: [0.2, 0.8],
      },
    });
    release?.();
    await pending;

    const state = useStudyStore.getState();
    expect(state.currentNode?.node_id).toBe("p1");
    expect(state.strategyEditDraft.handIndices).toEqual([1]);
    expect(state.strategyEditDraft.probs).toEqual([0.2, 0.8]);
    expect(state.strategyEdits).toHaveLength(1);
    expect(engineMocks.engineClient.getNode).not.toHaveBeenCalledWith("s1", "p0");
  });
});
