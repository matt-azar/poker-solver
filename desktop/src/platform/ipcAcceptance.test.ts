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

describe("runNodeSwitchWhileEvPendingProbe", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("passes when a later node values demuxes while the first stays pending", async () => {
    const { runNodeSwitchWhileEvPendingProbe } = await import("./ipcAcceptance");

    let resolveFirst: (v: unknown) => void = () => {};
    const firstPromise = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    let valuesCalls = 0;

    invoke.mockImplementation(
      async (cmd: string, args?: { op?: string; body?: { node_index?: number } }) => {
        if (cmd === "solver_engine_request" && args?.op === "values") {
          valuesCalls += 1;
          if (args.body?.node_index === 0) {
            return firstPromise;
          }
          return { body: { ok: true, actions: [], note: "late-or-second-values" } };
        }
        if (cmd === "solver_engine_request" && args?.op === "status") {
          return { body: { held_values: true } };
        }
        if (cmd === "solver_engine_info") {
          return { launchId: "zig-node-switch" };
        }
        if (cmd === "kill_solver_engine_cmd") {
          resolveFirst(new Error("killed"));
          return null;
        }
        throw new Error(`unexpected invoke ${cmd} ${JSON.stringify(args)}`);
      },
    );

    const result = await runNodeSwitchWhileEvPendingProbe();
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/node switch/);
    expect(valuesCalls).toBe(2);
  });
});
