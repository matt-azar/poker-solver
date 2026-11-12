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
  ipcValues,
  setHttpFallbackTransport,
  setIpcTransport,
} from "./transport";

describe("solver transport selection", () => {
  beforeEach(() => {
    invoke.mockReset();
    setHttpFallbackTransport();
  });

  it("labels HTTP as a temporary fallback", () => {
    const http = setHttpFallbackTransport();
    expect(http.kind).toBe("http-fallback");
    expect(http.label.toLowerCase()).toContain("temporary");
    expect(http.label.toLowerCase()).toContain("ipc");
    expect(getActiveTransport().kind).toBe("http-fallback");
  });

  it("records solver-engine IPC as the preferred Zig transport", () => {
    const ipc = setIpcTransport({
      protocol: 2,
      launchId: "zig-test",
      sidecar: "solver-engine",
      workers: 4,
    });
    expect(ipc.kind).toBe("ipc");
    expect(ipc.label).toContain("protocol 2");
    expect(getActiveTransport().kind).toBe("ipc");
    setHttpFallbackTransport();
  });
});

describe("ipcValues node targeting", () => {
  beforeEach(() => {
    invoke.mockReset();
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
