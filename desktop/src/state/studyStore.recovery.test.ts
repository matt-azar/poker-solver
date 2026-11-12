import { beforeEach, describe, expect, it, vi } from "vitest";
import { engineActivityMessage } from "../domain/solveActivity";
import { DEFAULT_SPOT } from "../domain/types";
import { solveControlFlags } from "../domain/solveControls";

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

const { resetStatusPollingForTests, useStudyStore } = await import("./studyStore");

describe("studyStore session recovery (ZR-123)", () => {
  beforeEach(() => {
    resetStatusPollingForTests();
    engineMocks.ensureEngine.mockClear();
    engineMocks.engineClient.solve.mockClear();
    engineMocks.engineClient.status.mockClear();
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
    // Cold sidecar status has no solution_id — drop stale Study identity.
    expect(state.solutionId).toBeNull();
  });

  it("markEngineSessionDead clears sticky busy without calling ensure", () => {
    useStudyStore.setState({
      phase: "solving",
      solutionId: "s1",
      connection: "connected",
    });
    useStudyStore.getState().markEngineSessionDead("Broken pipe");
    const state = useStudyStore.getState();
    expect(engineMocks.ensureEngine).not.toHaveBeenCalled();
    expect(state.connection).toBe("disconnected");
    expect(state.phase).toBe("failed");
    expect(solveControlFlags(state.phase).canSolve).toBe(true);
    expect(state.message).toMatch(/Reconnect/i);
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
