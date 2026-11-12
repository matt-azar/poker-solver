import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("../platform", () => ({
  isTauriRuntime: () => true,
}));

import { EngineClient } from "./client";
import { setHttpFallbackTransport, setIpcTransport } from "./transport";

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
    await expect(client.stop()).resolves.toEqual({ cancelled: true });
    expect(invoke).toHaveBeenCalledWith("solver_engine_request", {
      op: "cancel",
      body: null,
      jobId: "j-study",
    });

    invoke.mockResolvedValueOnce(okBody("cancel", { cancelled: true }));
    await client.stop("j-custom");
    expect(invoke).toHaveBeenLastCalledWith("solver_engine_request", {
      op: "cancel",
      body: null,
      jobId: "j-custom",
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

  it("keeps HTTP paths when transport is fallback", async () => {
    setHttpFallbackTransport();
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ phase: "paused" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    client = new EngineClient({ baseUrl: "http://127.0.0.1:8765", fetchImpl });
    await client.pause("j1");
    expect(fetchImpl).toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
