import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("../platform", () => ({
  isTauriRuntime: () => true,
}));

import { EngineClient } from "./client";
import {
  resetStudyJobIdCounterForTests,
  setHttpFallbackTransport,
  setIpcTransport,
} from "./transport";

function okBody(op: string, body: unknown) {
  return {
    v: 2,
    kind: "reply",
    request_id: "t",
    op,
    ok: true,
    body,
  };
}

describe("EngineClient Slice A IPC branches", () => {
  let client: EngineClient;

  beforeEach(() => {
    invoke.mockReset();
    resetStudyJobIdCounterForTests();
    client = new EngineClient({ baseUrl: "http://unused" });
    setIpcTransport({ protocol: 2, launchId: "t", sidecar: "solver-engine", workers: 1 });
  });

  it("routes pause and stop→cancel over IPC", async () => {
    invoke.mockResolvedValueOnce(okBody("pause", { phase: "paused" }));
    await expect(client.pause()).resolves.toEqual({ phase: "paused" });
    expect(invoke).toHaveBeenCalledWith("solver_engine_request", {
      op: "pause",
      body: null,
      jobId: null,
    });

    invoke.mockResolvedValueOnce(okBody("cancel", { cancelled: true }));
    await expect(client.stop()).rejects.toMatchObject({ name: "EngineError" });

    invoke.mockResolvedValueOnce(okBody("cancel", { cancelled: true }));
    await client.stop("j-custom");
    expect(invoke).toHaveBeenLastCalledWith("solver_engine_request", {
      op: "cancel",
      body: null,
      jobId: "j-custom",
    });
  });

  it("routes continueSolve over IPC as solve without begin_config", async () => {
    invoke.mockResolvedValueOnce(
      okBody("solve", {
        solution_id: 1,
        policy_revision: 4,
        trained: 15,
        terminal_reason: "completed",
        async: true,
      }),
    );
    const reply = await client.continueSolve("s1", { iterations: 5, time_limit: 30 });
    expect(reply).toMatchObject({
      running: false,
      job_id: "j1",
      solution_id: "s1",
      policy_revision: 4,
      trained: 15,
      terminal_reason: "completed",
      transport: "ipc",
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("solver_engine_request", {
      op: "solve",
      body: { iterations: 5, time_limit: 30 },
      jobId: "j1",
    });
  });

  it("routes getNode / open / save over IPC", async () => {
    invoke.mockResolvedValueOnce(
      okBody("node", {
        node_id: "p0.t-1.r-1",
        actions: ["Check"],
        combos: ["AsQs"],
        strategy: null,
        kind: "decision",
      }),
    );
    const node = await client.getNode("s1", "p0.t-1.r-1");
    expect(node.node_id).toBe("p0.t-1.r-1");
    expect(node.solution_id).toBe("s1");
    expect(invoke).toHaveBeenCalledWith("solver_engine_request", {
      op: "node",
      body: { node_id: "p0.t-1.r-1" },
      jobId: null,
    });

    invoke.mockResolvedValueOnce(
      okBody("open", {
        running: false,
        paused: false,
        cancelled: false,
        status_generation: 3,
        solution_id: "s2",
        root_node_id: "p0.t-1.r-1",
      }),
    );
    const status = await client.open("/tmp/demo.psol");
    expect(status.solution_id).toBe("s2");
    expect(status.running).toBe(false);

    invoke.mockResolvedValueOnce(okBody("save", { saved: true }));
    await expect(client.save("s2", "/tmp/demo.psol")).resolves.toEqual({ saved: true });
  });

  it("refuses HTTP in the Tauri shell when transport is fallback", async () => {
    setHttpFallbackTransport();
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ phase: "paused" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    client = new EngineClient({ baseUrl: "http://127.0.0.1:8765", fetchImpl });
    await expect(client.pause("j1")).rejects.toMatchObject({
      name: "EngineError",
      status: 501,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("EngineClient Slice C locks IPC branches", () => {
  let client: EngineClient;

  beforeEach(() => {
    invoke.mockReset();
    client = new EngineClient({ baseUrl: "http://unused" });
    setIpcTransport({ protocol: 2, launchId: "t", sidecar: "solver-engine", workers: 1 });
  });

  it("routes listLocks / putLock / deleteLock over IPC", async () => {
    invoke.mockResolvedValueOnce(okBody("list_locks", { locks: [] }));
    await expect(client.listLocks("s1")).resolves.toEqual({ locks: [] });
    expect(invoke).toHaveBeenCalledWith("solver_engine_request", {
      op: "list_locks",
      body: null,
      jobId: null,
    });

    const putBody = {
      node_id: "p0.t-1.r-1",
      kind: "full" as const,
      scope: "node" as const,
      probs: [0.4, 0.6],
    };
    invoke.mockResolvedValueOnce(
      okBody("put_lock", {
        locks: [{ node_id: "p0.t-1.r-1", kind: "full", scope: "node", hand_indices: [], probs: [0.4, 0.6] }],
      }),
    );
    const put = await client.putLock("s1", putBody);
    expect((put as { locks: unknown[] }).locks).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith("solver_engine_request", {
      op: "put_lock",
      body: putBody,
      jobId: null,
    });

    invoke.mockResolvedValueOnce(okBody("delete_lock", { locks: [] }));
    await expect(client.deleteLock("s1", "p0.t-1.r-1")).resolves.toEqual({ locks: [] });
    expect(invoke).toHaveBeenCalledWith("solver_engine_request", {
      op: "delete_lock",
      body: { node_id: "p0.t-1.r-1" },
      jobId: null,
    });

    invoke.mockResolvedValueOnce(okBody("delete_lock", { locks: [] }));
    await client.deleteLock("s1", "p0.t-1.r-1", 2);
    expect(invoke).toHaveBeenLastCalledWith("solver_engine_request", {
      op: "delete_lock",
      body: { node_id: "p0.t-1.r-1", hand_index: 2 },
      jobId: null,
    });
  });

  it("refuses locks HTTP in the Tauri shell when transport is fallback", async () => {
    setHttpFallbackTransport();
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ locks: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    client = new EngineClient({ baseUrl: "http://127.0.0.1:8765", fetchImpl });
    await expect(client.listLocks("s9")).rejects.toMatchObject({
      name: "EngineError",
      status: 501,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("EngineClient empty-base refuse", () => {
  beforeEach(() => {
    invoke.mockReset();
    setHttpFallbackTransport();
  });

  it("does not fetch when base URL is empty (Failed-to-fetch class)", async () => {
    const fetchImpl = vi.fn();
    const client = new EngineClient({ baseUrl: "", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.status()).rejects.toMatchObject({
      name: "EngineError",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
