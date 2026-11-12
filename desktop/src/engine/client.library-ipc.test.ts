import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("../platform", () => ({
  isTauriRuntime: () => true,
}));

describe("EngineClient library IPC", () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.resetModules();
  });

  it("lists templates via Tauri library commands when IPC transport is active", async () => {
    const { setIpcTransport } = await import("./transport");
    const { EngineClient } = await import("./client");
    setIpcTransport({
      protocol: 2,
      launchId: "test",
      sidecar: "solver-engine",
      workers: 1,
    });
    invoke.mockResolvedValueOnce([
      { id: "flop-small-bet", name: "flop-small-bet" },
    ]);
    const client = new EngineClient();
    const data = await client.templates();
    expect(invoke).toHaveBeenCalledWith("library_list_templates", {});
    expect(data).toEqual([{ id: "flop-small-bet", name: "flop-small-bet" }]);
  });

  it("does not fetch :8765 for library lists on IPC", async () => {
    const fetchImpl = vi.fn();
    const { setIpcTransport } = await import("./transport");
    const { EngineClient } = await import("./client");
    setIpcTransport({
      protocol: 2,
      launchId: "test",
      sidecar: "solver-engine",
      workers: 1,
    });
    invoke.mockResolvedValueOnce([]);
    const client = new EngineClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.recentSolutions();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("library_list_recent", {});
  });
});
