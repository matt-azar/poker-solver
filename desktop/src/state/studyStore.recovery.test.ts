import { beforeEach, describe, expect, it, vi } from "vitest";
import { engineActivityMessage } from "../domain/solveActivity";
import { DEFAULT_SPOT } from "../domain/types";
import { solveControlFlags } from "../domain/solveControls";
import { isStatusPollActive } from "./studySessionController";

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
      paused: false,
      cancelled: false,
      failed: false,
      solution_id: null,
      status_generation: 1,
      phase: "idle",
    });

  return {
    setStatusImpl(impl: typeof statusImpl) {
      statusImpl = impl;
    },
    ensureEngine: vi.fn(async () => ({
      ok: true as const,
      status: "solver-engine IPC (protocol 2)",
      transport: {
        kind: "ipc" as const,
        label: "solver-engine IPC (protocol 2)",
        protocol: 2,
        launchId: "launch-recover",
        sidecar: "solver-engine",
        workers: 1,
      },
    })),
    readEngineStatus: vi.fn(async () => "solver-engine IPC (protocol 2)"),
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
      getNode: vi.fn(async (solutionId: string, nodeId: string) => ({
        node_id: nodeId,
        solution_id: solutionId,
        actions: ["Check"],
        combos: ["AcAd"],
        kind: "decision",
      })),
      getSolutionConfig: vi.fn(async () => null),
      template: vi.fn(async () => ({ text: "" })),
      parseConfig: vi.fn(async () => ({})),
      pause: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      save: vi.fn(async () => undefined),
      setBaseUrl: vi.fn(),
      clearLastStudyJobId: vi.fn(),
    },
  };
});

vi.mock("../engine/client", () => ({
  EngineError: engineMocks.EngineError,
  engineClient: engineMocks.engineClient,
}));

vi.mock("../platform/engine", () => ({
  ensureEngine: engineMocks.ensureEngine,
  readEngineStatus: engineMocks.readEngineStatus,
}));

const diagMocks = vi.hoisted(() => ({
  reportSolveFailedFault: vi.fn(async () => undefined),
  reportUiHangEvent: vi.fn(async () => undefined),
  clearSolveFaultDedupe: vi.fn(),
  persistPreSolveDiagnostics: vi.fn(async () => undefined),
  STATUS_POLL_SLOW_MS: 1_500,
  summarizeLastSolve: vi.fn(() => ({
    snapshotKind: "pre-solve" as const,
    trigger: "solve" as const,
    street: "flop" as const,
    boardLen: 3,
    board: ["Ah", "Kd", "7c"],
    pot: 100,
    stack: 1000,
    iterations: 10,
    accuracy: null,
    timeLimit: null,
    memoryMib: 64,
    threads: 1,
    algorithm: null,
    frozen: 1,
    samples: null,
    rakeRate: 0,
    rakeCap: 0,
    useIcm: false,
    icmStacks: [] as number[],
    icmPayouts: [] as number[],
    potCap: 0,
    allowThreeBet: 1,
    allInThreshold: 0.5,
    maxRaises: 2,
    mergeThreshold: 0,
    publishEveryHint: 10,
    betSizes: {},
    ranges: {
      oop: { seat: "oop" as const, chars: 2, hash: "deadbeef" },
      ip: { seat: "ip" as const, chars: 2, hash: "cafebabe" },
    },
    treeEditCount: 0,
    incentiveCount: 0,
    edgeTagCount: 0,
  })),
  summarizeContinueSolve: vi.fn(() => null),
  boardLenFromStatusBoard: (board: unknown) => {
    if (Array.isArray(board)) {
      return board.length;
    }
    if (typeof board === "string" && board.trim()) {
      return board.trim().split(/\s+/).filter(Boolean).length;
    }
    return null;
  },
}));

vi.mock("../platform/diagnostics", () => ({
  reportSolveFailedFault: diagMocks.reportSolveFailedFault,
  reportUiHangEvent: diagMocks.reportUiHangEvent,
  clearSolveFaultDedupe: diagMocks.clearSolveFaultDedupe,
  persistPreSolveDiagnostics: diagMocks.persistPreSolveDiagnostics,
  STATUS_POLL_SLOW_MS: diagMocks.STATUS_POLL_SLOW_MS,
  summarizeLastSolve: diagMocks.summarizeLastSolve,
  summarizeContinueSolve: diagMocks.summarizeContinueSolve,
  boardLenFromStatusBoard: diagMocks.boardLenFromStatusBoard,
}));

const { resetStatusPollingForTests, useStudyStore } = await import("./studyStore");

describe("studyStore session recovery (ZR-123)", () => {
  beforeEach(() => {
    resetStatusPollingForTests();
    engineMocks.ensureEngine.mockClear();
    engineMocks.engineClient.solve.mockClear();
    engineMocks.engineClient.status.mockClear();
    engineMocks.engineClient.open.mockClear();
    engineMocks.engineClient.clearLastStudyJobId.mockClear();
    diagMocks.reportSolveFailedFault.mockClear();
    diagMocks.reportUiHangEvent.mockClear();
    diagMocks.clearSolveFaultDedupe.mockClear();
    diagMocks.persistPreSolveDiagnostics.mockClear();
    diagMocks.summarizeLastSolve.mockClear();
    diagMocks.summarizeContinueSolve.mockClear();
    engineMocks.setStatusImpl(async () => ({
      running: false,
      paused: false,
      cancelled: false,
      failed: false,
      solution_id: null,
      status_generation: 1,
      phase: "idle",
    }));
    useStudyStore.setState({
      draft: {
        ...DEFAULT_SPOT,
        boardText: "Ah Kd 7c",
        oopRange: "AA,KK",
        ipRange: "QQ+",
        pot: 5.5,
        stack: 97.5,
        iterations: 10,
        solutionPath: "",
      },
      solutionId: null,
      currentNode: null,
      status: null,
      phase: "idle",
      connection: "connected",
      message: "ready",
      solveValidationErrors: [],
    });
  });

  it("re-ensures after pipe death and clears sticky stop_requested", async () => {
    useStudyStore.setState({
      phase: "stop_requested",
      connection: "disconnected",
      message: "Engine unreachable: pipe closed",
      solutionId: "s1",
    });
    expect(solveControlFlags(useStudyStore.getState().phase).canSolve).toBe(
      false,
    );

    const result = await useStudyStore.getState().recoverEngineSession();
    expect(result.ok).toBe(true);
    expect(engineMocks.ensureEngine).toHaveBeenCalledTimes(1);
    expect(engineMocks.engineClient.clearLastStudyJobId).toHaveBeenCalled();

    const state = useStudyStore.getState();
    expect(state.connection).toBe("connected");
    expect(state.phase).not.toBe("stop_requested");
    expect(state.phase).not.toBe("solving");
    expect(solveControlFlags(state.phase).canSolve).toBe(true);
    expect(state.message).toMatch(/reconnected/i);
    expect(state.message).toMatch(/Unsaved train progress is gone/i);
    expect(state.phase).toBe("idle");
    // Cold sidecar status has no solution_id — drop stale Study identity.
    expect(state.solutionId).toBeNull();
  });

  it("markEngineSessionDead clears sticky busy and failed job without calling ensure", () => {
    useStudyStore.setState({
      phase: "solving",
      solutionId: "s1",
      connection: "connected",
    });
    useStudyStore.getState().startPolling();
    useStudyStore.getState().markEngineSessionDead("Broken pipe");
    const state = useStudyStore.getState();
    expect(engineMocks.ensureEngine).not.toHaveBeenCalled();
    expect(engineMocks.engineClient.clearLastStudyJobId).toHaveBeenCalled();
    expect(state.connection).toBe("disconnected");
    expect(state.phase).toBe("failed");
    expect(solveControlFlags(state.phase).canSolve).toBe(true);
    expect(state.message).toMatch(/Reconnect/i);
    // ZR-175: session-dead must stop the status-poll loop (no hung/kill storm).
    expect(isStatusPollActive()).toBe(false);
    expect(diagMocks.reportSolveFailedFault).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "Broken pipe",
        exitReason: "session-dead",
      }),
    );
  });

  it("status sticky last_error writes solve-failed diagnostics (ZR-163)", async () => {
    useStudyStore.setState({
      phase: "solving",
      connection: "connected",
      solutionId: "s1",
      draft: {
        ...useStudyStore.getState().draft,
        boardText: "Ah Kd 7c",
      },
    });
    engineMocks.setStatusImpl(async () => ({
      running: false,
      paused: false,
      cancelled: false,
      failed: true,
      last_error: "OutOfMemory",
      solution_id: "s1",
      status_generation: 9,
      phase: "failed",
      iterations: 11,
      board: ["Ah", "Kd", "7c"],
    }));
    await useStudyStore.getState().refresh();
    expect(useStudyStore.getState().phase).toBe("failed");
    expect(useStudyStore.getState().message).toMatch(/OutOfMemory/);
    expect(diagMocks.reportSolveFailedFault).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "OutOfMemory",
        exitReason: "solve-failed",
        iterations: 11,
        boardLen: 3,
        lastOp: "status",
      }),
    );
  });

  it("crash mid-solve → recover → reopen last saved checkpoint (ZR-143/ZR-157)", async () => {
    const checkpoint = "/tmp/zr143-last.psol";
    useStudyStore.setState({
      phase: "solving",
      connection: "connected",
      solutionId: "s-live",
      lastCheckpointPath: checkpoint,
      draft: {
        ...useStudyStore.getState().draft,
        solutionPath: checkpoint,
      },
    });

    // Pipe death while solving: clear sticky job, stay disconnected until Reconnect.
    useStudyStore.getState().markEngineSessionDead("solver-engine pipe closed");
    expect(engineMocks.engineClient.clearLastStudyJobId).toHaveBeenCalled();
    expect(useStudyStore.getState().connection).toBe("disconnected");
    expect(useStudyStore.getState().phase).toBe("failed");

    // Cold sidecar after re-ensure: no solution_id — unsaved live state is gone.
    engineMocks.setStatusImpl(async () => ({
      running: false,
      paused: false,
      cancelled: false,
      failed: false,
      solution_id: null,
      status_generation: 2,
      phase: "idle",
    }));
    const recovered = await useStudyStore.getState().recoverEngineSession();
    expect(recovered.ok).toBe(true);
    const afterRecover = useStudyStore.getState();
    expect(afterRecover.solutionId).toBeNull();
    expect(afterRecover.phase).toBe("idle");
    expect(afterRecover.lastCheckpointPath).toBe(checkpoint);
    expect(afterRecover.draft.solutionPath).toBe(checkpoint);
    expect(afterRecover.message).toMatch(/Unsaved train progress is gone/i);
    expect(afterRecover.message).toMatch(/Reopen last checkpoint/i);
    expect(afterRecover.message).toMatch(/zr143-last\.psol/);
    expect(solveControlFlags(afterRecover.phase).canSolve).toBe(true);

    // Reopen last checkpoint restores published identity from disk only.
    engineMocks.engineClient.open.mockResolvedValueOnce(undefined);
    engineMocks.setStatusImpl(async () => ({
      running: false,
      paused: false,
      cancelled: false,
      failed: false,
      solution_id: "s-ckpt",
      root_node_id: "p0.t-1.r-1",
      status_generation: 3,
      phase: "published",
      has_training: true,
      can_continue: true,
      iterations: 10,
    }));
    const opened = await useStudyStore.getState().reopenLastCheckpoint();
    expect(opened).toEqual({ ok: true, path: checkpoint });
    expect(engineMocks.engineClient.open).toHaveBeenCalledWith(checkpoint);
    const afterOpen = useStudyStore.getState();
    expect(afterOpen.solutionId).toBe("s-ckpt");
    expect(afterOpen.lastCheckpointPath).toBe(checkpoint);
    expect(afterOpen.draft.solutionPath).toBe(checkpoint);
    expect(afterOpen.status?.iterations).toBe(10);
  });

  it("reopenLastCheckpoint recovers a dead session then opens the Save/Open path (ZR-157)", async () => {
    const checkpoint = "/tmp/zr157-reopen.psol";
    useStudyStore.setState({
      phase: "failed",
      connection: "disconnected",
      solutionId: null,
      lastCheckpointPath: checkpoint,
      draft: {
        ...useStudyStore.getState().draft,
        // Typed draft path must not win over last successful Save/Open.
        solutionPath: "/tmp/typed-but-never-opened.psol",
      },
    });
    // Cold status until Open succeeds, then published checkpoint status.
    engineMocks.setStatusImpl(async () => ({
      running: false,
      paused: false,
      cancelled: false,
      failed: false,
      solution_id: null,
      status_generation: 4,
      phase: "idle",
    }));
    engineMocks.engineClient.open.mockImplementationOnce(async () => {
      engineMocks.setStatusImpl(async () => ({
        running: false,
        paused: false,
        cancelled: false,
        failed: false,
        solution_id: "s-reopen",
        root_node_id: "p0.t-1.r-1",
        status_generation: 5,
        phase: "published",
        has_training: true,
        can_continue: true,
        iterations: 10,
      }));
    });

    const result = await useStudyStore.getState().reopenLastCheckpoint();
    expect(result).toEqual({ ok: true, path: checkpoint });
    expect(engineMocks.ensureEngine).toHaveBeenCalled();
    expect(engineMocks.engineClient.open).toHaveBeenCalledWith(checkpoint);
    expect(useStudyStore.getState().solutionId).toBe("s-reopen");
    expect(useStudyStore.getState().lastCheckpointPath).toBe(checkpoint);
  });

  it("restart alone does not silently restore unsaved progress (ZR-143)", async () => {
    // Live published study that was never Saved (empty solutionPath).
    useStudyStore.setState({
      phase: "solving",
      connection: "connected",
      solutionId: "s-unsaved",
      lastCheckpointPath: "",
      draft: {
        ...useStudyStore.getState().draft,
        solutionPath: "",
      },
      status: {
        running: true,
        paused: false,
        solution_id: "s-unsaved",
        iterations: 40,
        iterations_requested: 200,
        phase: "training",
      },
    });
    useStudyStore.getState().markEngineSessionDead("Broken pipe");

    engineMocks.setStatusImpl(async () => ({
      running: false,
      paused: false,
      cancelled: false,
      failed: false,
      solution_id: null,
      status_generation: 7,
      phase: "idle",
    }));
    const recovered = await useStudyStore.getState().recoverEngineSession();
    expect(recovered.ok).toBe(true);
    const state = useStudyStore.getState();
    // Restart/re-ensure alone: no solution_id painted back from the dead session.
    expect(state.solutionId).toBeNull();
    expect(state.status?.solution_id ?? null).toBeNull();
    expect(state.draft.solutionPath).toBe("");
    expect(state.lastCheckpointPath).toBe("");
    expect(state.message).toMatch(/Unsaved train progress is gone/i);
    expect(state.message).toMatch(/Save before a crash/i);

    const missing = await useStudyStore.getState().reopenLastCheckpoint();
    expect(missing.ok).toBe(false);
    expect(engineMocks.engineClient.open).not.toHaveBeenCalled();
  });

  it("Solve after failed phase is allowed and launches a new job", async () => {
    useStudyStore.setState({
      phase: "failed",
      connection: "connected",
      message: "previous train failed",
      solutionId: null,
      draft: {
        ...DEFAULT_SPOT,
        boardText: "Ah Kd 7c",
        oopRange: "AA,KK",
        ipRange: "QQ+",
        pot: 5.5,
        stack: 97.5,
        iterations: 10,
      },
    });
    expect(solveControlFlags("failed").canSolve).toBe(true);

    engineMocks.setStatusImpl(async () => ({
      running: false,
      paused: false,
      cancelled: false,
      failed: false,
      solution_id: "s2",
      root_node_id: "p0.t-1.r-1",
      status_generation: 4,
      phase: "published",
    }));
    engineMocks.engineClient.solve.mockResolvedValueOnce(undefined);

    await useStudyStore.getState().solve();
    expect(engineMocks.engineClient.solve).toHaveBeenCalledTimes(1);
    const state = useStudyStore.getState();
    expect(state.phase).not.toBe("failed");
    expect(state.solutionId).toBe("s2");
  });

  it("ensure-fail recovery clears sticky solving and stays honestly disconnected", async () => {
    useStudyStore.setState({
      phase: "solving",
      connection: "disconnected",
      solutionId: null,
    });
    engineMocks.ensureEngine.mockResolvedValueOnce({
      ok: false as const,
      status: "solver-engine unavailable",
      error: "spawn failed",
      transport: {
        kind: "http-fallback" as const,
        label: "no engine",
      },
    });

    const result = await useStudyStore.getState().recoverEngineSession();
    expect(result.ok).toBe(false);
    const state = useStudyStore.getState();
    expect(state.connection).toBe("disconnected");
    expect(state.phase).toBe("idle");
    expect(solveControlFlags(state.phase).canSolve).toBe(true);
    expect(state.message).toMatch(/setup failed/i);
  });

  it("refresh maps host phase=failed to Study failed without permanent busy", async () => {
    engineMocks.setStatusImpl(async () => ({
      running: false,
      paused: false,
      cancelled: false,
      status_generation: 9,
      solution_id: "s1",
      root_node_id: "p0.t-1.r-1",
      phase: "failed",
    }));
    useStudyStore.setState({
      phase: "solving",
      connection: "connected",
      solutionId: "s1",
    });
    await useStudyStore.getState().refresh();
    const state = useStudyStore.getState();
    expect(state.phase).toBe("failed");
    expect(state.status?.failed).toBe(true);
    expect(state.message).toMatch(/failed/i);
    expect(state.message).not.toMatch(/complete/i);
    expect(solveControlFlags(state.phase).canSolve).toBe(true);
  });

  it("one soft status blip does not paint Engine unreachable (ZR-148)", async () => {
    engineMocks.setStatusImpl(async () => {
      throw new Error("transient decode glitch");
    });
    useStudyStore.setState({
      phase: "solving",
      connection: "connected",
      message: "Solving — 12/200 iterations",
      solutionId: "s1",
    });
    await useStudyStore.getState().refresh();
    const afterBlip = useStudyStore.getState();
    expect(afterBlip.connection).toBe("connected");
    expect(afterBlip.message).not.toMatch(/Engine unreachable/);
    expect(afterBlip.phase).toBe("solving");
  });

  it("hard pipe-closed status failure marks dead immediately (ZR-148)", async () => {
    engineMocks.setStatusImpl(async () => {
      throw new Error("Broken pipe");
    });
    useStudyStore.setState({
      phase: "solving",
      connection: "connected",
      solutionId: "s1",
    });
    await useStudyStore.getState().refresh();
    const state = useStudyStore.getState();
    expect(state.connection).toBe("disconnected");
    expect(state.message).toMatch(/Engine unreachable/);
    expect(state.phase).toBe("failed");
  });

  it("successful poll clears sticky unreachable message (ZR-148)", async () => {
    engineMocks.setStatusImpl(async () => ({
      running: false,
      paused: false,
      cancelled: false,
      failed: false,
      status_generation: 11,
      solution_id: null,
      phase: "idle",
    }));
    useStudyStore.setState({
      phase: "idle",
      connection: "disconnected",
      message:
        "Engine unreachable: status request timed out. Use Reconnect — Study will re-ensure the local solver-engine.",
      solutionId: null,
    });
    await useStudyStore.getState().refresh();
    const state = useStudyStore.getState();
    expect(state.connection).toBe("connected");
    expect(state.message).not.toMatch(/Engine unreachable/);
    expect(state.message).toMatch(/ready/i);
  });

  it("failed train with last_error does not claim Solve complete (ZR-148)", async () => {
    engineMocks.setStatusImpl(async () => ({
      running: false,
      paused: false,
      cancelled: false,
      failed: true,
      last_error: "InvalidSession",
      error: "InvalidSession",
      status_generation: 12,
      solution_id: "s-new",
      root_node_id: "p0.t-1.r-1",
      phase: "published",
      iterations: 40,
      iterations_requested: 200,
    }));
    useStudyStore.setState({
      phase: "solving",
      connection: "connected",
      message: "Solving — 40/200 iterations",
      solutionId: "s1",
    });
    await useStudyStore.getState().refresh();
    const state = useStudyStore.getState();
    expect(state.phase).toBe("failed");
    expect(state.status?.last_error).toBe("InvalidSession");
    // Footer sentence prefers sticky last_error over any store fallback
    // (navigate/analysis may overwrite message after reload).
    expect(
      engineActivityMessage(state.phase, state.status, state.message),
    ).toBe("InvalidSession");
    expect(
      engineActivityMessage(state.phase, state.status, "Solve complete."),
    ).not.toMatch(/complete/i);
  });

  it("preserves pause_requested while host still reports running (ZR-148)", async () => {
    engineMocks.setStatusImpl(async () => ({
      running: true,
      paused: false,
      cancelled: false,
      phase: "training",
      iterations: 8,
      iterations_requested: 100,
      job_id: "j-study-2",
      status_generation: 13,
    }));
    useStudyStore.setState({
      phase: "pause_requested",
      connection: "connected",
      message: "Pause requested — finishing current sample…",
      solutionId: "s1",
    });
    await useStudyStore.getState().refresh();
    const state = useStudyStore.getState();
    expect(state.phase).toBe("pause_requested");
    expect(state.message).toMatch(/Pause requested/i);
    expect(state.status?.job_id).toBe("j-study-2");
  });
});
