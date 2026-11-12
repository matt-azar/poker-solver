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

describe("EngineClient parseConfig IPC (ZR-86)", () => {
  let client: EngineClient;

  beforeEach(() => {
    invoke.mockReset();
    client = new EngineClient({ baseUrl: "http://unused" });
    setIpcTransport({ protocol: 2, launchId: "t", sidecar: "solver-engine", workers: 1 });
  });

  it("parses street-config locally without solver_engine_request", async () => {
    const text = [
      "street-config 1",
      "board Ah Kd 7c",
      "pot 100",
      "stack 100",
      "oop-range AcAd:1",
      "ip-range 2c3d:1",
      "max-raises 0",
      "allow-all-in 0",
      "allow-three-bet 1",
      "memory-mib 64",
      "threads 1",
      "",
    ].join("\n");
    const parsed = await client.parseConfig(text);
    expect(parsed.kind).toBe("street");
    expect(parsed.board).toEqual(["Ah", "Kd", "7c"]);
    expect(parsed.oop_range).toBe("AcAd:1");
    expect(parsed.ip_range).toBe("2c3d:1");
    expect(parsed.pot).toBe(100);
    expect(parsed.tree_edits).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith(
      "solver_engine_request",
      expect.anything(),
    );
  });

  it("maps invalid text to EngineError 400 (not 501)", async () => {
    await expect(client.parseConfig("")).rejects.toMatchObject({
      name: "EngineError",
      status: 400,
    });
    await expect(client.parseConfig("not-a-config\n")).rejects.toMatchObject({
      name: "EngineError",
      status: 400,
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("EngineClient ZR-83 treePreview / planMemory IPC", () => {
  let client: EngineClient;

  beforeEach(() => {
    invoke.mockReset();
    client = new EngineClient({ baseUrl: "http://unused" });
    setIpcTransport({ protocol: 2, launchId: "t", sidecar: "solver-engine", workers: 1 });
  });

  it("routes treePreview(SolveJobRequest) as tree_preview with config_text", async () => {
    const plan = {
      estimated_peak_bytes: 4096,
      memory_budget_bytes: 67_108_864,
      deals: 1,
      infosets: 2,
      decision_nodes: 6,
      terminals: 1,
      public_decisions: 6,
      threads: 1,
      fits_budget: true,
      dry_run: true,
    };
    const payload = {
      nodes: [
        {
          index: 0,
          terminal: false,
          chance: false,
          player: 0,
          street: 0,
          path: "",
          chance_child: -1,
          actions: [{ label: "Check", compact: "c", child_index: 1 }],
          children: [1],
        },
      ],
      tree_edits: [],
      plan,
    };
    invoke.mockResolvedValueOnce(okBody("tree_preview", payload));
    const job = {
      board: ["Ah", "Kd", "7c"],
      oop_range: "AcAd:1",
      ip_range: "2c3d:1",
      pot: 100,
      stack: 100,
      oop_bets: [] as number[],
      ip_bets: [] as number[],
      iterations: 1,
      memory_mib: 64,
      threads: 1,
    };
    await expect(client.treePreview(job)).resolves.toEqual(payload);
    expect(invoke).toHaveBeenCalledWith("solver_engine_request", {
      op: "tree_preview",
      body: {
        config_text: expect.stringContaining("street-config 1"),
      },
      jobId: null,
    });
    const body = invoke.mock.calls[0]?.[1]?.body as { config_text: string };
    expect(body.config_text).toContain("board Ah Kd 7c");
  });

  it("routes planMemory({ text }) as plan_memory with that config_text", async () => {
    const plan = {
      estimated_peak_bytes: 2048,
      memory_budget_bytes: 67_108_864,
      deals: 1,
      infosets: 2,
      decision_nodes: 6,
      terminals: 1,
      public_decisions: 6,
      threads: 1,
      fits_budget: true,
      dry_run: true,
    };
    invoke.mockResolvedValueOnce(okBody("plan_memory", plan));
    const text = "street-config 1\nboard Ah Kd 7c\n";
    await expect(client.planMemory({ text })).resolves.toEqual(plan);
    expect(invoke).toHaveBeenCalledWith("solver_engine_request", {
      op: "plan_memory",
      body: { config_text: text },
      jobId: null,
    });
  });
});
