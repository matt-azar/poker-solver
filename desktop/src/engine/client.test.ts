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
  setNoEngineTransport,
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
        accepted: true,
        running: true,
        solution_id: 1,
        async: true,
        threads: 1,
      }),
    );
    const reply = await client.continueSolve("s1", { iterations: 5, time_limit: 30 });
    expect(reply).toMatchObject({
      running: true,
      job_id: "j1",
      solution_id: "s1",
      trained: 0,
      terminal_reason: "admitted",
      transport: "ipc",
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("solver_engine_request", {
      op: "solve",
      body: { iterations: 5, time_limit: 30 },
      jobId: "j1",
    });
  });

  it("routes resolveLocked over IPC as resolve_locked", async () => {
    invoke.mockResolvedValueOnce(
      okBody("resolve_locked", {
        accepted: true,
        running: true,
        solution_id: 2,
        async: true,
        threads: 1,
      }),
    );
    const reply = await client.resolveLocked("s1", {
      iterations: 8,
      warm_start: 0,
      time_limit: 12,
    });
    expect(reply).toMatchObject({
      running: true,
      job_id: "j1",
      solution_id: "s2",
      trained: 0,
      terminal_reason: "admitted",
      transport: "ipc",
      warm_start: "reset",
    });
    expect(invoke).toHaveBeenCalledWith("solver_engine_request", {
      op: "resolve_locked",
      body: { iterations: 8, warm_start: 0, time_limit: 12 },
      jobId: "j1",
    });
  });

  it("admits solve quickly and leaves completion to status polling", async () => {
    invoke
      .mockResolvedValueOnce(okBody("begin_config", { solution_id: 3 }))
      .mockResolvedValueOnce(
        okBody("solve", {
          accepted: true,
          running: true,
          solution_id: 3,
          async: true,
          threads: 2,
        }),
      );
    const reply = await client.solve({
      board: ["Ah", "Kd", "7c"],
      pot: 100,
      stack: 200,
      oop_range: "AA",
      ip_range: "KK",
      oop_bets: [],
      ip_bets: [],
      iterations: 200,
      memory_mib: 1024,
      threads: 2,
    });
    expect(reply).toMatchObject({
      running: true,
      job_id: "j1",
      solution_id: "s3",
      terminal_reason: "admitted",
      transport: "ipc",
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

  it("refuses HTTP in the Tauri shell when transport is no-engine", async () => {
    setNoEngineTransport();
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ phase: "paused" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    client = new EngineClient({ baseUrl: "http://127.0.0.1:9", fetchImpl });
    await expect(client.pause("j1")).rejects.toMatchObject({
      name: "EngineError",
      status: 501,
      message: expect.stringMatching(/unavailable in the packaged Study shell/i),
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

  it("refuses locks HTTP in the Tauri shell when transport is no-engine", async () => {
    setNoEngineTransport();
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ locks: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    client = new EngineClient({ baseUrl: "http://127.0.0.1:9", fetchImpl });
    await expect(client.listLocks("s9")).rejects.toMatchObject({
      name: "EngineError",
      status: 501,
      message: expect.stringMatching(/unavailable in the packaged Study shell/i),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("EngineClient ZR-101 strategy-edits IPC branches", () => {
  let client: EngineClient;

  beforeEach(() => {
    invoke.mockReset();
    client = new EngineClient({ baseUrl: "http://unused" });
    setIpcTransport({ protocol: 2, launchId: "t", sidecar: "solver-engine", workers: 1 });
  });

  it("routes listStrategyEdits / putStrategyEdit / deleteStrategyEdit over IPC", async () => {
    invoke.mockResolvedValueOnce(okBody("list_strategy_edits", { edits: [], persisted: false }));
    await expect(client.listStrategyEdits("s1")).resolves.toEqual({
      edits: [],
      persisted: false,
    });
    expect(invoke).toHaveBeenCalledWith("solver_engine_request", {
      op: "list_strategy_edits",
      body: null,
      jobId: null,
    });

    const putBody = {
      node_id: "p0.t-1.r-1",
      kind: "full" as const,
      probs: [0.0, 1.0],
    };
    invoke.mockResolvedValueOnce(
      okBody("put_strategy_edit", {
        edits: [
          {
            node_id: "p0.t-1.r-1",
            kind: "full",
            hand_indices: [],
            probs: [0.0, 1.0],
          },
        ],
        persisted: false,
      }),
    );
    const put = await client.putStrategyEdit("s1", putBody);
    expect((put as { edits: unknown[] }).edits).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith("solver_engine_request", {
      op: "put_strategy_edit",
      body: putBody,
      jobId: null,
    });

    invoke.mockResolvedValueOnce(okBody("delete_strategy_edit", { edits: [], persisted: false }));
    await expect(client.deleteStrategyEdit("s1", "p0.t-1.r-1")).resolves.toEqual({
      edits: [],
      persisted: false,
    });
    expect(invoke).toHaveBeenCalledWith("solver_engine_request", {
      op: "delete_strategy_edit",
      body: { node_id: "p0.t-1.r-1" },
      jobId: null,
    });

    invoke.mockResolvedValueOnce(okBody("delete_strategy_edit", { edits: [], persisted: false }));
    await client.deleteStrategyEdit("s1", "p0.t-1.r-1", 2);
    expect(invoke).toHaveBeenLastCalledWith("solver_engine_request", {
      op: "delete_strategy_edit",
      body: { node_id: "p0.t-1.r-1", hand_index: 2 },
      jobId: null,
    });
  });
});

describe("EngineClient empty-base refuse", () => {
  beforeEach(() => {
    invoke.mockReset();
    setNoEngineTransport();
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
      "allow-three-bet 1",
      "all-in-threshold 0.5",
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
    expect(parsed.all_in_threshold).toBe(0.5);
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

describe("EngineClient ZR-83 treePreview IPC", () => {
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

});

describe("EngineClient Equity calculator jobs IPC (ZR-84)", () => {
  let client: EngineClient;

  beforeEach(() => {
    invoke.mockReset();
    client = new EngineClient({ baseUrl: "http://unused" });
    setIpcTransport({ protocol: 2, launchId: "t", sidecar: "solver-engine", workers: 1 });
  });

  it("routes start/get/cancel equity jobs over IPC", async () => {
    const startBody = {
      version: 1,
      client_revision: "r1",
      method: "exact",
      board: ["2c", "3d", "7h", "9s", "Jc"],
      dead_cards: [],
      players: [
        { id: "p1", range: "AsAd" },
        { id: "p2", range: "KcKd" },
      ],
      target_samples: 100000,
      seed: 1,
    };
    invoke.mockResolvedValueOnce(okBody("start_equity_job", { job_id: "eq1", state: "queued" }));
    await expect(client.startEquityJob(startBody)).resolves.toEqual({
      job_id: "eq1",
      state: "queued",
    });
    expect(invoke).toHaveBeenCalledWith("solver_engine_request", {
      op: "start_equity_job",
      body: startBody,
      jobId: null,
    });

    invoke.mockResolvedValueOnce(
      okBody("get_equity_job", {
        job_id: "eq1",
        state: "completed",
        client_revision: "r1",
        progress_done: 1,
        progress_total: 1,
        elapsed_seconds: 0.01,
        result: { joint_defined: true },
      }),
    );
    const status = await client.getEquityJob("eq1");
    expect((status as { state: string }).state).toBe("completed");
    expect(invoke).toHaveBeenCalledWith("solver_engine_request", {
      op: "get_equity_job",
      body: { job_id: "eq1" },
      jobId: null,
    });

    invoke.mockResolvedValueOnce(
      okBody("cancel_equity_job", {
        job_id: "eq1",
        state: "cancelled",
        client_revision: "r1",
        progress_done: 0,
        progress_total: 0,
        elapsed_seconds: 0,
      }),
    );
    await client.cancelEquityJob("eq1");
    expect(invoke).toHaveBeenLastCalledWith("solver_engine_request", {
      op: "cancel_equity_job",
      body: { job_id: "eq1" },
      jobId: null,
    });
  });
});

describe("EngineClient ZR-103 getCategories / compare IPC", () => {
  let client: EngineClient;

  beforeEach(() => {
    invoke.mockReset();
    client = new EngineClient({ baseUrl: "http://unused" });
    setIpcTransport({ protocol: 2, launchId: "t", sidecar: "solver-engine", workers: 1 });
  });

  it("routes getCategories over IPC (no HTTP categories 501 string)", async () => {
    invoke.mockResolvedValueOnce(
      okBody("categories", {
        pending: false,
        kind: "categories",
        model: "made-hand",
        available: true,
        exclusive: true,
        categories: ["high card", "pair"],
        oop: { defined: true, total_mass: 1, fractions: [0, 1], mass: [0, 1] },
        ip: { defined: true, total_mass: 1, fractions: [1, 0], mass: [1, 0] },
        node_id: "p0.t-1.r-1",
      }),
    );
    const body = (await client.getCategories("s1", "p0.t-1.r-1")) as {
      solution_id?: string;
      node_id?: string;
      available?: boolean;
    };
    expect(body.solution_id).toBe("s1");
    expect(body.node_id).toBe("p0.t-1.r-1");
    expect(body.available).toBe(true);
    expect(invoke).toHaveBeenCalledWith("solver_engine_request", {
      op: "categories",
      body: { node_index: 0, node_id: "p0.t-1.r-1" },
      jobId: null,
    });
  });

  it("compare stays explicit dual-session deferred 501 on IPC", async () => {
    await expect(client.compare("base", "s1", "p0.t-1.r-1")).rejects.toMatchObject({
      name: "EngineError",
      status: 501,
      message: expect.stringMatching(/dual-session baseline/i),
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});
