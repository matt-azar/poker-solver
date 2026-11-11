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
  let statusImpl: (signal?: AbortSignal) => Promise<Record<string, unknown>> =
    async () => ({
      running: false,
      solution_id: null,
      status_generation: 0,
    });
  let getNodeImpl: (
    solutionId: string,
    nodeId: string,
  ) => Promise<Record<string, unknown>> = async (solutionId, nodeId) => ({
    node_id: nodeId,
    solution_id: solutionId,
    actions: ["Check"],
    combos: ["AcAd"],
  });

  return {
    setStatusImpl(impl: typeof statusImpl) {
      statusImpl = impl;
    },
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
      solve: vi.fn(async () => undefined),
      continueSolve: vi.fn(async () => undefined),
      resolveLocked: vi.fn(async () => undefined),
      open: vi.fn(async () => undefined),
      status: vi.fn(async (signal?: AbortSignal) => statusImpl(signal)),
      getNode: vi.fn(async (solutionId: string, nodeId: string) =>
        getNodeImpl(solutionId, nodeId),
      ),
      getSolutionConfig: vi.fn(async () => null),
      template: vi.fn(async () => ({ text: "" })),
      parseConfig: vi.fn(async () => ({})),
      pause: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      save: vi.fn(async () => undefined),
    },
  };
});

vi.mock("../engine/client", () => ({
  EngineError: engineMocks.EngineError,
  engineClient: engineMocks.engineClient,
}));

const { resetStatusPollingForTests, useStudyStore } = await import("./studyStore");

function seedPublishedStudy() {
  useStudyStore.setState({
    draft: {
      ...DEFAULT_SPOT,
      boardText: "Ah Kd 7c",
      oopRange: "AA,KK",
      ipRange: "QQ+",
      pot: 5.5,
      stack: 97.5,
      iterations: 10,
      solutionPath: "/good.psol",
      rakeRate: 0.05,
      rakeCap: 3,
    },
    solutionId: "s1",
    baselineSolutionId: null,
    currentNode: {
      node_id: "p0.child",
      solution_id: "s1",
      actions: ["Check", "Bet 50"],
      combos: ["AcAd"],
      kind: "decision",
      player: 0,
    },
    pathTrail: [
      { kind: "root", nodeId: "root", label: "Root" },
      { kind: "action", nodeId: "p0.child", label: "Bet 50" },
    ],
    navHistory: [{ nodeId: "p0.child", trail: [] }],
    navHistoryIndex: 0,
    canNavBack: false,
    canNavForward: false,
    nodeValues: { node_id: "p0.child", value: [1] },
    equity: { node_id: "p0.child", pending: false },
    runouts: null,
    categories: null,
    compareNote: null,
    setupMeta: {
      profile: null,
      rangeSnapshot: { oop: "AA,KK", ip: "QQ+" },
      profileDataRevision: null,
      provenance: {},
      summary: ["seeded"],
      conflicts: [],
      missing: [],
      canSolve: true,
    },
    status: {
      running: false,
      solution_id: "s1",
      root_node_id: "root",
      status_generation: 5,
    },
    phase: "complete",
    message: "ready",
    solveValidationErrors: [],
    selectedCell: { row: 0, col: 0, text: "AA" },
  });
}

describe("studyStore lifecycle guards (R04/R08/R09)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStatusPollingForTests();
    seedPublishedStudy();
    engineMocks.setStatusImpl(async () => ({
      running: false,
      solution_id: "s1",
      root_node_id: "root",
      status_generation: 5,
    }));
    engineMocks.setGetNodeImpl(async (solutionId, nodeId) => ({
      node_id: nodeId,
      solution_id: solutionId,
      actions: ["Check"],
      combos: ["AcAd"],
      kind: "decision",
      player: 0,
    }));
  });

  it("R04: delayed s1 node cannot repopulate during s2 solve", async () => {
    let releaseStaleNode: (() => void) | null = null;
    const staleGate = new Promise<void>((resolve) => {
      releaseStaleNode = resolve;
    });
    let getNodeCalls = 0;
    engineMocks.setGetNodeImpl(async (solutionId, nodeId) => {
      getNodeCalls += 1;
      if (getNodeCalls === 1) {
        // In-flight browse for the old solution.
        await staleGate;
        return {
          node_id: "p0.child",
          solution_id: "s1",
          actions: ["Check", "Bet 50"],
          combos: ["AcAd"],
          kind: "decision",
          player: 0,
        };
      }
      return {
        node_id: nodeId,
        solution_id: solutionId,
        actions: ["Check"],
        combos: ["AcAd"],
        kind: "decision",
        player: 0,
      };
    });
    engineMocks.engineClient.solve.mockResolvedValueOnce(undefined);
    engineMocks.setStatusImpl(async () => ({
      running: false,
      solution_id: "s2",
      root_node_id: "root",
      status_generation: 6,
    }));

    const staleNav = useStudyStore.getState().navigateTo("p0.stale");
    await Promise.resolve();
    await useStudyStore.getState().solve();
    releaseStaleNode?.();
    await staleNav;

    const state = useStudyStore.getState();
    expect(state.solutionId).toBe("s2");
    expect(state.currentNode?.node_id).toBe("root");
    expect(state.currentNode?.solution_id).toBe("s2");
  });

  it("R04: successful solve reloads at root for the new solution", async () => {
    engineMocks.engineClient.solve.mockResolvedValueOnce(undefined);
    engineMocks.setStatusImpl(async () => ({
      running: false,
      solution_id: "s2",
      root_node_id: "root",
      status_generation: 6,
    }));

    await useStudyStore.getState().solve();
    const state = useStudyStore.getState();
    expect(state.solutionId).toBe("s2");
    expect(state.currentNode?.node_id).toBe("root");
    expect(engineMocks.engineClient.getNode).toHaveBeenCalledWith("s2", "root");
  });

  it("R09: failed solve restores the last published study", async () => {
    engineMocks.engineClient.solve.mockRejectedValueOnce(
      new engineMocks.EngineError("engine rejected solve"),
    );
    await useStudyStore.getState().solve();
    const state = useStudyStore.getState();
    expect(state.solutionId).toBe("s1");
    expect(state.currentNode?.node_id).toBe("p0.child");
    expect(state.nodeValues?.node_id).toBe("p0.child");
    expect(state.equity).toEqual({ node_id: "p0.child", pending: false });
    expect(state.phase).toBe("failed");
  });

  it("R08: single-flight queues a follow-up so the newer generation wins", async () => {
    let releaseStale: (() => void) | null = null;
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    let calls = 0;
    engineMocks.setStatusImpl(async () => {
      calls += 1;
      if (calls === 1) {
        await staleGate;
        return {
          running: false,
          solution_id: "s-old",
          root_node_id: "root",
          status_generation: 4,
        };
      }
      return {
        running: false,
        solution_id: "s-new",
        root_node_id: "root",
        status_generation: 8,
      };
    });

    // Overlapping refresh() coalesces: the second call queues a follow-up
    // instead of issuing a concurrent request. Release before awaiting both.
    const first = useStudyStore.getState().refresh();
    await Promise.resolve();
    const second = useStudyStore.getState().refresh();
    releaseStale?.();
    await Promise.all([first, second]);

    const state = useStudyStore.getState();
    expect(calls).toBe(2);
    expect(state.status?.solution_id).toBe("s-new");
    expect(state.status?.status_generation).toBe(8);
  });

  it("R08: engine restart generation re-baselines instead of wedging", async () => {
    // Establish a high seen generation via a normal refresh.
    engineMocks.setStatusImpl(async () => ({
      running: false,
      solution_id: "s1",
      root_node_id: "root",
      status_generation: 12,
    }));
    await useStudyStore.getState().refresh();
    expect(useStudyStore.getState().status?.status_generation).toBe(12);

    engineMocks.setStatusImpl(async () => ({
      running: false,
      solution_id: null,
      root_node_id: null,
      status_generation: 0,
    }));
    await useStudyStore.getState().refresh();
    expect(useStudyStore.getState().status?.status_generation).toBe(0);
  });

  it("R09: invalid range does not clear the published study", async () => {
    useStudyStore.setState({
      draft: {
        ...useStudyStore.getState().draft,
        oopRange: "AA,NOT_A_HAND",
      },
    });
    await useStudyStore.getState().solve();
    const state = useStudyStore.getState();
    expect(engineMocks.engineClient.solve).not.toHaveBeenCalled();
    expect(state.solutionId).toBe("s1");
    expect(state.currentNode?.node_id).toBe("p0.child");
    expect(state.nodeValues?.node_id).toBe("p0.child");
    expect(state.phase).toBe("complete");
    expect(state.solveValidationErrors.length).toBeGreaterThan(0);
  });

  it("R09: missing checkpoint restores the last valid study", async () => {
    engineMocks.engineClient.open.mockRejectedValueOnce(
      new engineMocks.EngineError("checkpoint not found", 404),
    );
    const result = await useStudyStore.getState().openSolution("/missing.psol");
    expect(result).toEqual({ ok: false, error: "checkpoint not found" });
    const state = useStudyStore.getState();
    expect(state.solutionId).toBe("s1");
    expect(state.currentNode?.node_id).toBe("p0.child");
    expect(state.nodeValues?.node_id).toBe("p0.child");
    expect(state.equity).toEqual({ node_id: "p0.child", pending: false });
    expect(state.phase).toBe("failed");
    expect(state.message).toMatch(/checkpoint not found/i);
  });

  it("failed Open preserves draft path, undo, and setup meta", async () => {
    // Build range undo history against the good document.
    useStudyStore.getState().setRangeText("oop", "AA,KK,QQ");
    expect(useStudyStore.getState().canUndoRange).toBe(true);
    expect(useStudyStore.getState().draft.solutionPath).toBe("/good.psol");
    expect(useStudyStore.getState().setupMeta?.summary).toEqual(["seeded"]);

    engineMocks.engineClient.open.mockRejectedValueOnce(
      new engineMocks.EngineError("checkpoint not found", 404),
    );
    const result = await useStudyStore.getState().openSolution("/failed.psol");
    expect(result.ok).toBe(false);

    const state = useStudyStore.getState();
    // Path must stay on the good document — Save must not target /failed.psol.
    expect(state.draft.solutionPath).toBe("/good.psol");
    expect(state.draft.oopRange).toBe("AA,KK,QQ");
    expect(state.canUndoRange).toBe(true);
    expect(state.setupMeta?.summary).toEqual(["seeded"]);
    expect(state.solutionId).toBe("s1");
    expect(state.currentNode?.node_id).toBe("p0.child");
    expect(state.phase).toBe("failed");
  });

  it("failed Save As keeps the previous path; successful Save As commits the new path", async () => {
    expect(useStudyStore.getState().draft.solutionPath).toBe("/good.psol");

    engineMocks.engineClient.save.mockRejectedValueOnce(
      new engineMocks.EngineError("disk full", 500),
    );
    const failed = await useStudyStore
      .getState()
      .saveSolution("/other.psol");
    expect(failed).toEqual({ ok: false, error: "disk full" });
    expect(useStudyStore.getState().draft.solutionPath).toBe("/good.psol");
    expect(useStudyStore.getState().message).toMatch(/disk full/i);

    engineMocks.engineClient.save.mockResolvedValueOnce(undefined);
    const saved = await useStudyStore.getState().saveSolution("/other.psol");
    expect(saved).toEqual({ ok: true, path: "/other.psol" });
    expect(useStudyStore.getState().draft.solutionPath).toBe("/other.psol");
    expect(engineMocks.engineClient.save).toHaveBeenLastCalledWith(
      "s1",
      "/other.psol",
    );
  });

  it("openSolution keeps polling while a slow open fails without painting unreachable", async () => {
    let releaseOpen: (() => void) | null = null;
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    let statusCalls = 0;

    engineMocks.engineClient.status.mockImplementation(async () => {
      statusCalls += 1;
      return {
        running: true,
        paused: false,
        cancelled: false,
        status_generation: statusCalls,
        solution_id: "s1",
        error: "",
      };
    });
    engineMocks.engineClient.open.mockImplementationOnce(async () => {
      await openGate;
      throw new engineMocks.EngineError("checkpoint not found", 404);
    });

    useStudyStore.setState({
      connection: "connected",
      message: "ready",
      phase: "complete",
    });
    useStudyStore.getState().startPolling();
    await Promise.resolve();

    const pending = useStudyStore.getState().openSolution("/slow.psol");
    await Promise.resolve();
    await Promise.resolve();

    expect(useStudyStore.getState().connection).toBe("connected");
    expect(useStudyStore.getState().message).toMatch(/Opening \/slow\.psol/);
    expect(useStudyStore.getState().message).not.toMatch(/Engine unreachable/);
    expect(statusCalls).toBeGreaterThan(0);

    releaseOpen?.();
    const result = await pending;
    expect(result).toEqual({ ok: false, error: "checkpoint not found" });
    expect(useStudyStore.getState().message).not.toMatch(/Engine unreachable/);
    expect(useStudyStore.getState().connection).toBe("connected");
  });

  it("zero-rake full template resets a 5% rake draft for the next job", async () => {
    expect(useStudyStore.getState().draft.rakeRate).toBe(0.05);

    engineMocks.engineClient.template.mockResolvedValueOnce({
      text: "street-config 1\nrake-rate 0\nrake-cap 0\n",
    });
    engineMocks.engineClient.parseConfig.mockResolvedValueOnce({
      kind: "street",
      board: ["Ah", "Kd", "7c"],
      pot: 100,
      stack: 100,
      oop_range: "AcAd:1",
      ip_range: "2c3d:1",
      max_raises: 0,
      allow_all_in: false,
      allow_three_bet: true,
      pot_cap: 0,
      all_in_threshold: 0,
      rake_rate: 0,
      rake_cap: 0,
      icm_stacks: [],
      icm_payouts: [],
      incentives: [],
      edge_tags: [],
      oop_bets: [],
      ip_bets: [],
      oop_raises: [],
      ip_raises: [],
      memory_mib: 64,
      threads: 1,
      tree_edits: [],
    });

    await useStudyStore.getState().applyTemplate("flop-check-down");
    const state = useStudyStore.getState();
    expect(state.draft.rakeRate).toBe(0);
    expect(state.draft.rakeCap).toBe(0);
    expect(state.draft.solutionPath).toBe("/good.psol");
    expect(state.draft.oopRange).toBe("AcAd:1");
    expect(state.draft.useIcm).toBe(false);
    expect(state.draft.incentives).toBe("");
    expect(state.workspace).toBe("build");

    const { buildJob } = await import("./studyDraft");
    const job = buildJob(state.draft);
    expect(job.rake_rate).toBe(0);
    expect(job.rake_cap).toBe(0);
  });
});
