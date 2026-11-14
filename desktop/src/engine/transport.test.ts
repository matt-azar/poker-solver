import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("../platform", () => ({
  isTauriRuntime: () => true,
}));

import {
  getActiveTransport,
  ipcCancel,
  ipcDeleteLock,
  ipcDeleteStrategyEdit,
  ipcEquity,
  ipcListLocks,
  ipcListStrategyEdits,
  ipcNode,
  ipcOpen,
  ipcPause,
  ipcPlanMemory,
  ipcPutLock,
  ipcPutStrategyEdit,
  ipcResolveLocked,
  ipcSave,
  ipcTreePreview,
  ipcValues,
  killSolverEngineIpc,
  parseSolverIpcInvokeError,
  resetAnalysisIpcSerialForTests,
  setNoEngineTransport,
  setIpcTransport,
  SolverIpcError,
  solverEngineRequest,
} from "./transport";

describe("solver transport selection", () => {
  beforeEach(() => {
    invoke.mockReset();
    setNoEngineTransport();
  });

  it("labels no-engine as browser/dev only (not packaged)", () => {
    const none = setNoEngineTransport();
    expect(none.kind).toBe("no-engine");
    expect(none.label.toLowerCase()).toContain("browser/dev");
    expect(none.label.toLowerCase()).toContain("solver-engine");
    expect(getActiveTransport().kind).toBe("no-engine");
  });

  it("records solver-engine IPC as the packaged Zig transport", () => {
    const ipc = setIpcTransport({
      protocol: 2,
      launchId: "zig-test",
      sidecar: "solver-engine",
      workers: 4,
    });
    expect(ipc.kind).toBe("ipc");
    expect(ipc.label).toContain("protocol 2");
    expect(getActiveTransport().kind).toBe("ipc");
    setNoEngineTransport();
  });
});

describe("ipcValues node targeting", () => {
  beforeEach(() => {
    invoke.mockReset();
    resetAnalysisIpcSerialForTests();
    setIpcTransport({ protocol: 2, launchId: "t", sidecar: "solver-engine", workers: 1 });
  });

  it("sends Study node_id strings instead of forcing root index 0", async () => {
    invoke.mockResolvedValue({
      v: 2,
      kind: "reply",
      request_id: "t1",
      job_id: null,
      op: "values",
      ok: true,
      body: {
        node_id: "p2.t-1.r-1",
        actions: ["Check", "Bet 100"],
        combos: ["AsQs"],
        action_ev: [[1, 2]],
        value: [1.5],
        ev_defined: [true],
      },
    });
    const body = (await ipcValues("p2.t-1.r-1")) as { node_id?: string };
    expect(body.node_id).toBe("p2.t-1.r-1");
    expect(invoke).toHaveBeenCalledWith("solver_engine_request", {
      op: "values",
      body: { node_id: "p2.t-1.r-1" },
      jobId: null,
    });
  });

  it("keeps numeric node_index for harness callers", async () => {
    invoke.mockResolvedValue({
      v: 2,
      kind: "reply",
      request_id: "t2",
      op: "values",
      ok: true,
      body: { node_index: 0 },
    });
    await ipcValues(0);
    expect(invoke).toHaveBeenCalledWith("solver_engine_request", {
      op: "values",
      body: { node_index: 0 },
      jobId: null,
    });
  });
});

describe("analysis IPC serialization", () => {
  beforeEach(() => {
    invoke.mockReset();
    resetAnalysisIpcSerialForTests();
    setIpcTransport({ protocol: 2, launchId: "t", sidecar: "solver-engine", workers: 1 });
  });

  it("holds values until an overlapping node inspect finishes admitting", async () => {
    const order: string[] = [];
    let releaseNode!: () => void;
    const nodeGate = new Promise<void>((resolve) => {
      releaseNode = resolve;
    });
    invoke.mockImplementation(async (_cmd: string, args: { op?: string }) => {
      const op = args?.op ?? "";
      if (op === "node") {
        order.push("node-start");
        await nodeGate;
        order.push("node-end");
        return {
          v: 2,
          kind: "reply",
          request_id: "n",
          op: "node",
          ok: true,
          body: { node_id: "root", strategy: [[0.7, 0.3]] },
        };
      }
      if (op === "values") {
        order.push("values");
        return {
          v: 2,
          kind: "reply",
          request_id: "v",
          op: "values",
          ok: true,
          body: { node_id: "root", pending: false },
        };
      }
      throw new Error(`unexpected op ${op}`);
    });

    const nodePromise = ipcNode("root");
    await Promise.resolve();
    const valuesPromise = ipcValues("root");
    await vi.waitFor(() => expect(order).toContain("node-start"));
    expect(order).not.toContain("values");
    releaseNode();
    await Promise.all([nodePromise, valuesPromise]);
    expect(order).toEqual(["node-start", "node-end", "values"]);
  });

  it("serializes equity behind values on the worker chain", async () => {
    const order: string[] = [];
    let releaseValues!: () => void;
    const valuesGate = new Promise<void>((resolve) => {
      releaseValues = resolve;
    });
    invoke.mockImplementation(async (_cmd: string, args: { op?: string }) => {
      const op = args?.op ?? "";
      if (op === "values") {
        order.push("values-start");
        await valuesGate;
        order.push("values-end");
        return {
          v: 2,
          kind: "reply",
          request_id: "v",
          op: "values",
          ok: true,
          body: { pending: false },
        };
      }
      if (op === "equity") {
        order.push("equity");
        return {
          v: 2,
          kind: "reply",
          request_id: "e",
          op: "equity",
          ok: true,
          body: { pending: false },
        };
      }
      throw new Error(`unexpected op ${op}`);
    });

    const valuesPromise = ipcValues("root");
    await Promise.resolve();
    const equityPromise = ipcEquity({ nodeId: "root" });
    await vi.waitFor(() => expect(order).toContain("values-start"));
    expect(order).not.toContain("equity");
    releaseValues();
    await Promise.all([valuesPromise, equityPromise]);
    expect(order).toEqual(["values-start", "values-end", "equity"]);
  });
});

describe("Slice A IPC lifecycle + node helpers", () => {
  beforeEach(() => {
    invoke.mockReset();
    resetAnalysisIpcSerialForTests();
    setIpcTransport({ protocol: 2, launchId: "t", sidecar: "solver-engine", workers: 1 });
  });

  it("sends Study node_id on node inspect", async () => {
    invoke.mockResolvedValue({
      v: 2,
      kind: "reply",
      request_id: "n1",
      op: "node",
      ok: true,
      body: {
        node_id: "p0.t-1.r-1",
        actions: ["Check", "Bet 100"],
        combos: ["AsQs"],
        strategy: [[0.4, 0.6]],
      },
    });
    const body = (await ipcNode("p0.t-1.r-1")) as { strategy?: number[][] };
    expect(body.strategy?.[0]).toEqual([0.4, 0.6]);
    expect(invoke).toHaveBeenCalledWith("solver_engine_request", {
      op: "node",
      body: { node_id: "p0.t-1.r-1" },
      jobId: null,
    });
  });

  it("routes pause / cancel / open / save ops", async () => {
    invoke.mockResolvedValue({
      v: 2,
      kind: "reply",
      request_id: "x",
      op: "pause",
      ok: true,
      body: { phase: "paused" },
    });
    await ipcPause();
    expect(invoke).toHaveBeenCalledWith("solver_engine_request", {
      op: "pause",
      body: null,
      jobId: null,
    });

    invoke.mockResolvedValue({
      v: 2,
      kind: "reply",
      request_id: "c",
      op: "cancel",
      ok: true,
      body: { cancelled: true },
    });
    await ipcCancel("j1");
    expect(invoke).toHaveBeenCalledWith("solver_engine_request", {
      op: "cancel",
      body: null,
      jobId: "j1",
    });

    invoke.mockResolvedValue({
      v: 2,
      kind: "reply",
      request_id: "o",
      op: "open",
      ok: true,
      body: {
        running: false,
        paused: false,
        cancelled: false,
        status_generation: 1,
        solution_id: "s1",
      },
    });
    await ipcOpen("/tmp/x.psol");
    expect(invoke).toHaveBeenCalledWith("solver_engine_request", {
      op: "open",
      body: { path: "/tmp/x.psol" },
      jobId: null,
    });

    invoke.mockResolvedValue({
      v: 2,
      kind: "reply",
      request_id: "s",
      op: "save",
      ok: true,
      body: { saved: true },
    });
    await ipcSave("/tmp/x.psol");
    expect(invoke).toHaveBeenCalledWith("solver_engine_request", {
      op: "save",
      body: { path: "/tmp/x.psol" },
      jobId: null,
    });
  });
});

describe("ZR-83 tree_preview / plan_memory IPC helpers", () => {
  beforeEach(() => {
    invoke.mockReset();
    setIpcTransport({ protocol: 2, launchId: "t", sidecar: "solver-engine", workers: 1 });
  });

  it("sends config_text for tree_preview and plan_memory", async () => {
    invoke.mockResolvedValue({
      v: 2,
      kind: "reply",
      request_id: "tp",
      op: "tree_preview",
      ok: true,
      body: { nodes: [], tree_edits: [], plan: { dry_run: true } },
    });
    await ipcTreePreview("street-config 1\nboard Ah Kd 7c\n");
    expect(invoke).toHaveBeenCalledWith("solver_engine_request", {
      op: "tree_preview",
      body: { config_text: "street-config 1\nboard Ah Kd 7c\n" },
      jobId: null,
    });

    invoke.mockResolvedValue({
      v: 2,
      kind: "reply",
      request_id: "pm",
      op: "plan_memory",
      ok: true,
      body: { estimated_peak_bytes: 1, fits_budget: true, dry_run: true },
    });
    await ipcPlanMemory("street-config 1\n");
    expect(invoke).toHaveBeenCalledWith("solver_engine_request", {
      op: "plan_memory",
      body: { config_text: "street-config 1\n" },
      jobId: null,
    });
  });
});

describe("Slice C locks IPC helpers", () => {
  beforeEach(() => {
    invoke.mockReset();
    setIpcTransport({ protocol: 2, launchId: "t", sidecar: "solver-engine", workers: 1 });
  });

  it("routes list / put / delete lock ops", async () => {
    invoke.mockResolvedValue({
      v: 2,
      kind: "reply",
      request_id: "l",
      op: "list_locks",
      ok: true,
      body: { locks: [] },
    });
    await ipcListLocks();
    expect(invoke).toHaveBeenCalledWith("solver_engine_request", {
      op: "list_locks",
      body: null,
      jobId: null,
    });

    invoke.mockResolvedValue({
      v: 2,
      kind: "reply",
      request_id: "p",
      op: "put_lock",
      ok: true,
      body: { locks: [{ node_id: "p0.t-1.r-1" }] },
    });
    await ipcPutLock({
      node_id: "p0.t-1.r-1",
      kind: "selected",
      scope: "line",
      hand_indices: [0, 1],
      probs: [1, 0],
    });
    expect(invoke).toHaveBeenCalledWith("solver_engine_request", {
      op: "put_lock",
      body: {
        node_id: "p0.t-1.r-1",
        kind: "selected",
        scope: "line",
        hand_indices: [0, 1],
        probs: [1, 0],
      },
      jobId: null,
    });

    invoke.mockResolvedValue({
      v: 2,
      kind: "reply",
      request_id: "d",
      op: "delete_lock",
      ok: true,
      body: { locks: [] },
    });
    await ipcDeleteLock({ nodeId: "p0.t-1.r-1", handIndex: 1 });
    expect(invoke).toHaveBeenCalledWith("solver_engine_request", {
      op: "delete_lock",
      body: { node_id: "p0.t-1.r-1", hand_index: 1 },
      jobId: null,
    });
  });

  it("routes resolve_locked with warm_start and job id", async () => {
    invoke.mockResolvedValue({
      v: 2,
      kind: "reply",
      request_id: "rl",
      op: "resolve_locked",
      ok: true,
      body: { solution_id: 3, trained: 4, terminal_reason: "completed" },
    });
    await ipcResolveLocked({
      iterations: 4,
      warm_start: 1,
      time_limit: 9,
      jobId: "j-rl",
    });
    expect(invoke).toHaveBeenCalledWith("solver_engine_request", {
      op: "resolve_locked",
      body: { iterations: 4, warm_start: 1, time_limit: 9 },
      jobId: "j-rl",
    });
  });
});

describe("solverEngineRequest honest errors", () => {
  beforeEach(() => {
    invoke.mockReset();
    setIpcTransport({ protocol: 2, launchId: "t", sidecar: "solver-engine", workers: 1 });
  });

  it("surfaces invalid_frame error_code / message from ok:false replies", async () => {
    invoke.mockResolvedValue({
      v: 2,
      kind: "reply",
      request_id: "r-bad",
      op: "node",
      ok: false,
      error_code: "invalid_frame",
      error_message: "expected request",
      body: null,
    });
    try {
      await solverEngineRequest("node", { node_id: "p0.t-1.r-1" });
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(SolverIpcError);
      const ipcErr = err as SolverIpcError;
      expect(ipcErr.ipcClass).toBe("engine_rejection");
      expect(ipcErr.errorCode).toBe("invalid_frame");
      expect(ipcErr.message).toMatch(/expected request/i);
    }
  });

  it("parses structured connection_loss invoke errors", () => {
    const err = parseSolverIpcInvokeError(
      {
        class: "connection_loss",
        message: "solver-engine pipe closed",
        launch_id: "zig-abc",
      },
      "status",
    );
    expect(err.ipcClass).toBe("connection_loss");
    expect(err.launchId).toBe("zig-abc");
    expect(err.message).toMatch(/pipe closed/i);
  });
});

describe("launch-scoped hung kill", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    setNoEngineTransport();
  });

  it("passes expected launch id and clears matching IPC transport", async () => {
    setIpcTransport({
      protocol: 2,
      launchId: "zig-hung-1",
      sidecar: "solver-engine",
      workers: 1,
    });
    await killSolverEngineIpc("zig-hung-1");
    expect(invoke).toHaveBeenCalledWith("kill_solver_engine_cmd", {
      expectedLaunchId: "zig-hung-1",
    });
    expect(getActiveTransport().kind).toBe("no-engine");
  });

  it("stale launch id does not clear a newer IPC session", async () => {
    setIpcTransport({
      protocol: 2,
      launchId: "zig-engine-b",
      sidecar: "solver-engine",
      workers: 1,
    });
    await killSolverEngineIpc("zig-engine-a");
    expect(invoke).toHaveBeenCalledWith("kill_solver_engine_cmd", {
      expectedLaunchId: "zig-engine-a",
    });
    const transport = getActiveTransport();
    expect(transport.kind).toBe("ipc");
    if (transport.kind === "ipc") {
      expect(transport.launchId).toBe("zig-engine-b");
    }
  });

  it("refuses blind kill when no launch id is known", async () => {
    setNoEngineTransport();
    await killSolverEngineIpc();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("ZR-101 strategy-edits IPC helpers", () => {
  beforeEach(() => {
    invoke.mockReset();
    setIpcTransport({ protocol: 2, launchId: "t", sidecar: "solver-engine", workers: 1 });
  });

  it("routes list / put / delete strategy-edit ops", async () => {
    invoke.mockResolvedValue({
      v: 2,
      kind: "reply",
      request_id: "e",
      op: "list_strategy_edits",
      ok: true,
      body: { edits: [], persisted: false },
    });
    await ipcListStrategyEdits();
    expect(invoke).toHaveBeenCalledWith("solver_engine_request", {
      op: "list_strategy_edits",
      body: null,
      jobId: null,
    });

    invoke.mockResolvedValue({
      v: 2,
      kind: "reply",
      request_id: "p",
      op: "put_strategy_edit",
      ok: true,
      body: { edits: [{ node_id: "p0.t-1.r-1" }], persisted: false },
    });
    await ipcPutStrategyEdit({
      node_id: "p0.t-1.r-1",
      kind: "selected",
      hand_indices: [0, 1],
      probs: [1, 0],
    });
    expect(invoke).toHaveBeenCalledWith("solver_engine_request", {
      op: "put_strategy_edit",
      body: {
        node_id: "p0.t-1.r-1",
        kind: "selected",
        hand_indices: [0, 1],
        probs: [1, 0],
      },
      jobId: null,
    });

    invoke.mockResolvedValue({
      v: 2,
      kind: "reply",
      request_id: "d",
      op: "delete_strategy_edit",
      ok: true,
      body: { edits: [], persisted: false },
    });
    await ipcDeleteStrategyEdit({ nodeId: "p0.t-1.r-1", handIndex: 1 });
    expect(invoke).toHaveBeenCalledWith("solver_engine_request", {
      op: "delete_strategy_edit",
      body: { node_id: "p0.t-1.r-1", hand_index: 1 },
      jobId: null,
    });
  });
});
