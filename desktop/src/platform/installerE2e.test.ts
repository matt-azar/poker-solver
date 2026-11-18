import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("./index", () => ({
  isTauriRuntime: () => true,
}));

describe("runInstallerE2eStageA", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("proves WebView control via ensure + status + launchId", async () => {
    const { runInstallerE2eStageA } = await import("./installerE2e");
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ensure_solver_engine") return { ok: true };
      if (cmd === "solver_engine_request") return { ok: true, body: { running: false } };
      if (cmd === "solver_engine_info") return { launchId: "launch-e2e-a" };
      throw new Error(`unexpected invoke ${cmd}`);
    });
    const result = await runInstallerE2eStageA();
    expect(result.ok).toBe(true);
    expect(result.lastCompletedStep).toBe("webview-control-proven");
    expect(result.detail).toContain("launch-e2e-a");
  });

  it("reports lastCompletedStep when ensure fails", async () => {
    const { runInstallerE2eStageA } = await import("./installerE2e");
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ensure_solver_engine") throw new Error("sidecar missing");
      throw new Error(`unexpected invoke ${cmd}`);
    });
    const result = await runInstallerE2eStageA();
    expect(result.ok).toBe(false);
    expect(result.lastCompletedStep).toBe("ensure_solver_engine");
    expect(result.detail).toMatch(/sidecar missing/);
  });
});

describe("strategyFingerprint / weightedActionFreqs", () => {
  it("fingerprints reach-weighted freqs", async () => {
    const { strategyFingerprint, weightedActionFreqs } = await import("./installerE2e");
    const node = {
      node_id: "p0.t-1.r-1",
      kind: "decision",
      n_actions: 2,
      reach: [1, 1],
      strategy: [
        [1, 0],
        [0, 1],
      ],
      children: ["p0.t-1.r-1.c0", "p0.t-1.r-1.c1"],
    };
    expect(weightedActionFreqs(node)).toEqual([0.5, 0.5]);
    expect(strategyFingerprint(node)).toContain('"freqs":["0.500000","0.500000"]');
  });
});

describe("runInstallerE2eStageB", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("solve → browse → clear → reopen restores strategy fingerprint", async () => {
    const { runInstallerE2eStageB } = await import("./installerE2e");
    const rootNode = {
      node_id: "p0.t-1.r-1",
      kind: "decision",
      n_actions: 2,
      n_hands: 2,
      reach: [1, 1],
      marginal: [0.5, 0.5],
      actions: ["c", "b"],
      strategy: [
        [0.75, 0.25],
        [0.25, 0.75],
      ],
      children: ["p0.t-1.r-1.c0"],
    };
    let cleared = false;
    let opened = false;
    invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "ensure_solver_engine") {
        return { ok: true, launchId: cleared ? "launch-b2" : "launch-b1" };
      }
      if (cmd === "installer_e2e_psol_path") {
        return "C:\\temp\\stage-b.psol";
      }
      if (cmd === "solver_engine_info") {
        return { launchId: cleared ? "launch-b2" : "launch-b1" };
      }
      if (cmd === "kill_solver_engine_cmd") {
        expect(args?.expectedLaunchId).toBe("launch-b1");
        cleared = true;
        return null;
      }
      if (cmd === "solver_engine_request") {
        const op = String(args?.op ?? "");
        if (op === "begin_config") {
          return { ok: true, body: { solution_id: "s1" } };
        }
        if (op === "solve") {
          return { ok: true, body: { accepted: true, running: true, async: true, solution_id: "s1" } };
        }
        if (op === "status") {
          if (cleared && !opened) {
            return { ok: true, body: { running: false, solution_id: null, has_training: false } };
          }
          return {
            ok: true,
            body: {
              running: false,
              has_training: true,
              iterations: 10,
              solution_id: "s1",
              phase: "published",
            },
          };
        }
        if (op === "node") {
          const body = asBody(args?.body);
          if (cleared && !opened) {
            return { ok: false, error_code: "nothing_published", body: null };
          }
          if (body?.node_id === "p0.t-1.r-1.c0") {
            return { ok: true, body: { node_id: "p0.t-1.r-1.c0", kind: "terminal" } };
          }
          return { ok: true, body: rootNode };
        }
        if (op === "save") {
          return { ok: true, body: { saved: true } };
        }
        if (op === "open") {
          opened = true;
          return {
            ok: true,
            body: { has_training: true, can_continue: true, solution_id: "s2", running: false },
          };
        }
        throw new Error(`unexpected op ${op}`);
      }
      throw new Error(`unexpected invoke ${cmd}`);
    });

    const result = await runInstallerE2eStageB();
    expect(result.ok).toBe(true);
    expect(result.lastCompletedStep).toBe("stage-b-pass");
    expect(result.detail).toMatch(/clear\/reopen ok/);
    expect(cleared).toBe(true);
    expect(opened).toBe(true);
  });

  it("fails verify-cleared when solution survives kill", async () => {
    const { runInstallerE2eStageB } = await import("./installerE2e");
    const rootNode = {
      node_id: "p0.t-1.r-1",
      kind: "decision",
      n_actions: 2,
      reach: [1],
      strategy: [[1, 0]],
      children: ["p0.t-1.r-1.c0"],
    };
    invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "ensure_solver_engine") return { ok: true, launchId: "L" };
      if (cmd === "installer_e2e_psol_path") return "/tmp/x.psol";
      if (cmd === "solver_engine_info") return { launchId: "L" };
      if (cmd === "kill_solver_engine_cmd") return null;
      if (cmd === "solver_engine_request") {
        const op = String(args?.op ?? "");
        if (op === "begin_config") return { ok: true, body: { solution_id: "s1" } };
        if (op === "solve") return { ok: true, body: { accepted: true, running: true } };
        if (op === "status") {
          return {
            ok: true,
            body: { running: false, has_training: true, iterations: 10, solution_id: "s1" },
          };
        }
        if (op === "node") {
          const body = asBody(args?.body);
          if (body?.node_id === "p0.t-1.r-1.c0") {
            return { ok: true, body: { node_id: "p0.t-1.r-1.c0", kind: "terminal" } };
          }
          return { ok: true, body: rootNode };
        }
        if (op === "save") return { ok: true, body: { saved: true } };
        throw new Error(`unexpected op ${op}`);
      }
      throw new Error(`unexpected invoke ${cmd}`);
    });
    const result = await runInstallerE2eStageB();
    expect(result.ok).toBe(false);
    expect(result.lastCompletedStep).toBe("verify-cleared");
    expect(result.detail).toMatch(/still active after clear/);
  });
});

function asBody(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

describe("maybeRunInstallerE2eAndExit IPC probe stages", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("runs BlockedWrite via STUDY_INSTALLER_E2E=stage-blocked-write (fail when unarmed)", async () => {
    const { maybeRunInstallerE2eAndExit } = await import("./installerE2e");
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "installer_e2e_stage") return "stage-blocked-write";
      if (cmd === "ensure_solver_engine") return { ok: true };
      if (cmd === "ipc_blocked_write_armed") return false;
      if (cmd === "solver_engine_extra_args") return [];
      if (cmd === "exit_with_code") return null;
      throw new Error(`unexpected invoke ${cmd}`);
    });
    const handled = await maybeRunInstallerE2eAndExit();
    expect(handled).toBe(true);
    expect(invoke).toHaveBeenCalledWith("exit_with_code", { code: 1 });
  });

  it("runs BlockedWrite PASS when arm + write bound are observed", async () => {
    const { maybeRunInstallerE2eAndExit } = await import("./installerE2e");
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "installer_e2e_stage") return "stage-blocked-write";
      if (cmd === "ensure_solver_engine") return { ok: true };
      if (cmd === "ipc_blocked_write_armed") return true;
      if (cmd === "solver_engine_extra_args") {
        return ["--stop-reading-after", "1", "--partial-drain-bytes", "4"];
      }
      if (cmd === "solver_engine_request") {
        throw new Error("unknown-after-write: op save");
      }
      if (cmd === "solver_engine_info") return { launchId: "L1" };
      if (cmd === "kill_solver_engine_cmd") return null;
      if (cmd === "exit_with_code") return null;
      throw new Error(`unexpected invoke ${cmd}`);
    });
    const handled = await maybeRunInstallerE2eAndExit();
    expect(handled).toBe(true);
    expect(invoke).toHaveBeenCalledWith("exit_with_code", { code: 0 });
  });

  it("runs StaleCallAfterReconnect via stage-stale-call-after-reconnect", async () => {
    const { maybeRunInstallerE2eAndExit } = await import("./installerE2e");
    let launch = "launch-a";
    let resolveValues: (v: unknown) => void = () => {};
    const valuesPromise = new Promise((_resolve, reject) => {
      resolveValues = reject;
    });
    invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "installer_e2e_stage") return "stage-stale-call-after-reconnect";
      if (cmd === "ensure_solver_engine") return { ok: true };
      if (cmd === "solver_engine_info") return { launchId: launch };
      if (cmd === "solver_engine_request" && args?.op === "values") return valuesPromise;
      if (cmd === "kill_solver_engine_cmd") {
        launch = "launch-b";
        resolveValues(new Error("closed"));
        return null;
      }
      if (cmd === "solver_engine_request" && args?.op === "status") {
        return { ok: true, body: { running: false } };
      }
      if (cmd === "exit_with_code") return null;
      throw new Error(`unexpected invoke ${cmd}`);
    });
    const handled = await maybeRunInstallerE2eAndExit();
    expect(handled).toBe(true);
    expect(invoke).toHaveBeenCalledWith("exit_with_code", { code: 0 });
  });
});

