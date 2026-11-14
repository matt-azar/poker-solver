import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("./index", () => ({
  isTauriRuntime: () => true,
}));

describe("runIpcAcceptanceProbe", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("passes when status and cancel complete while values is pending", async () => {
    const { runIpcAcceptanceProbe } = await import("./ipcAcceptance");

    let resolveValues: (v: unknown) => void = () => {};
    const valuesPromise = new Promise((resolve) => {
      resolveValues = resolve;
    });

    invoke.mockImplementation(async (cmd: string, args?: { op?: string }) => {
      if (cmd === "solver_engine_request" && args?.op === "values") {
        return valuesPromise;
      }
      if (cmd === "solver_engine_request" && args?.op === "status") {
        return { body: { held_values: true } };
      }
      if (cmd === "solver_engine_request" && args?.op === "cancel") {
        return { body: { cancelled: true } };
      }
      if (cmd === "solver_engine_info") {
        return { launchId: "zig-test" };
      }
      if (cmd === "kill_solver_engine_cmd") {
        resolveValues(new Error("killed"));
        return null;
      }
      throw new Error(`unexpected invoke ${cmd}`);
    });

    const result = await runIpcAcceptanceProbe();
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/status\+cancel/);
  });
});
