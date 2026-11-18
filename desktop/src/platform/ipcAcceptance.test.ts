import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("./index", () => ({
  isTauriRuntime: () => true,
}));

describe("normalizeIpcAcceptanceStage / INSTALLER_E2E_ENV_BY_STAGE", () => {
  it("maps CI stage-* env tokens and -Stage names", async () => {
    const {
      normalizeIpcAcceptanceStage,
      INSTALLER_E2E_ENV_BY_STAGE,
      isInstallerIpcProbeStage,
    } = await import("./ipcAcceptance");

    expect(normalizeIpcAcceptanceStage("stage-blocked-write")).toBe("BlockedWrite");
    expect(normalizeIpcAcceptanceStage("stage-normal-close-pending")).toBe(
      "NormalClosePending",
    );
    expect(normalizeIpcAcceptanceStage("stage-stale-call-after-reconnect")).toBe(
      "StaleCallAfterReconnect",
    );
    expect(normalizeIpcAcceptanceStage("BlockedWrite")).toBe("BlockedWrite");
    expect(normalizeIpcAcceptanceStage("NormalClosePending")).toBe("NormalClosePending");
    expect(normalizeIpcAcceptanceStage("StaleCallAfterReconnect")).toBe(
      "StaleCallAfterReconnect",
    );
    expect(normalizeIpcAcceptanceStage("DelayedReply")).toBe("DelayedReply");

    expect(INSTALLER_E2E_ENV_BY_STAGE.BlockedWrite).toBe("stage-blocked-write");
    expect(INSTALLER_E2E_ENV_BY_STAGE.NormalClosePending).toBe(
      "stage-normal-close-pending",
    );
    expect(INSTALLER_E2E_ENV_BY_STAGE.StaleCallAfterReconnect).toBe(
      "stage-stale-call-after-reconnect",
    );

    expect(isInstallerIpcProbeStage("stage-blocked-write")).toBe(true);
    expect(isInstallerIpcProbeStage("DelayedReply")).toBe(false);
    expect(isInstallerIpcProbeStage("stage-a")).toBe(false);
  });
});

describe("runIpcAcceptanceProbe / DelayedReply", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("passes when status and cancel complete while values is pending", async () => {
    const { runIpcAcceptanceProbe, runDelayedReplyProbe } = await import("./ipcAcceptance");

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

    const result = await runDelayedReplyProbe();
    expect(result.ok).toBe(true);
    expect(result.stage).toBe("DelayedReply");
    expect(result.detail).toMatch(/status\+cancel/);

    // Deprecated alias still works.
    invoke.mockClear();
    let resolveValues2: (v: unknown) => void = () => {};
    const valuesPromise2 = new Promise((resolve) => {
      resolveValues2 = resolve;
    });
    invoke.mockImplementation(async (cmd: string, args?: { op?: string }) => {
      if (cmd === "solver_engine_request" && args?.op === "values") return valuesPromise2;
      if (cmd === "solver_engine_request" && args?.op === "status") {
        return { body: { held_values: true } };
      }
      if (cmd === "solver_engine_request" && args?.op === "cancel") {
        return { body: { cancelled: true } };
      }
      if (cmd === "solver_engine_info") return { launchId: "zig-test" };
      if (cmd === "kill_solver_engine_cmd") {
        resolveValues2(new Error("killed"));
        return null;
      }
      throw new Error(`unexpected invoke ${cmd}`);
    });
    const alias = await runIpcAcceptanceProbe();
    expect(alias.ok).toBe(true);
    expect(alias.stage).toBe("DelayedReply");
  });
});

describe("runBlockedWriteProbe", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("fails when the Rust blocked-write arm is not active", async () => {
    const { runBlockedWriteProbe } = await import("./ipcAcceptance");
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ipc_blocked_write_armed") return false;
      if (cmd === "solver_engine_extra_args") return [];
      throw new Error(`unexpected invoke ${cmd}`);
    });
    const result = await runBlockedWriteProbe();
    expect(result.ok).toBe(false);
    expect(result.skipped).toBeFalsy();
    expect(result.stage).toBe("BlockedWrite");
    expect(result.detail).toMatch(/arm not active/);
  });

  it("fails when armed but sidecar keeps answering", async () => {
    const { runBlockedWriteProbe } = await import("./ipcAcceptance");
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ipc_blocked_write_armed") return true;
      if (cmd === "solver_engine_extra_args") {
        return ["--stop-reading-after", "1"];
      }
      if (cmd === "solver_engine_request") {
        return { ok: true, body: { kind: "decision" } };
      }
      throw new Error(`unexpected invoke ${cmd}`);
    });
    const result = await runBlockedWriteProbe();
    expect(result.ok).toBe(false);
    expect(result.skipped).toBeFalsy();
    expect(result.detail).toMatch(/no write\/admission bound/);
  });

  it("passes when a write/admission bound is observed", async () => {
    const { runBlockedWriteProbe } = await import("./ipcAcceptance");
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ipc_blocked_write_armed") return true;
      if (cmd === "solver_engine_extra_args") {
        return ["--stop-reading-after", "0", "--partial-drain-bytes", "4"];
      }
      if (cmd === "solver_engine_request") {
        throw new Error("unknown-after-write: op save deadline elapsed after write started");
      }
      if (cmd === "solver_engine_info") return { launchId: "L1" };
      if (cmd === "kill_solver_engine_cmd") return null;
      throw new Error(`unexpected invoke ${cmd}`);
    });
    const result = await runBlockedWriteProbe();
    expect(result.ok).toBe(true);
    expect(result.skipped).toBeFalsy();
    expect(result.detail).toMatch(/bound observed/);
  });
});

describe("runStaleCallAfterReconnectProbe", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("passes when launch B accepts status after stale A settles", async () => {
    const { runStaleCallAfterReconnectProbe } = await import("./ipcAcceptance");
    let launch = "launch-a";
    let resolveValues: (v: unknown) => void = () => {};
    const valuesPromise = new Promise((resolve, reject) => {
      resolveValues = reject;
    });

    invoke.mockImplementation(async (cmd: string, args?: { op?: string; expectedLaunchId?: string }) => {
      if (cmd === "solver_engine_info") return { launchId: launch };
      if (cmd === "solver_engine_request" && args?.op === "values") return valuesPromise;
      if (cmd === "kill_solver_engine_cmd") {
        expect(args?.expectedLaunchId).toBe("launch-a");
        launch = "launch-b";
        resolveValues(new Error("connection closed"));
        return null;
      }
      if (cmd === "ensure_solver_engine") return { ok: true };
      if (cmd === "solver_engine_request" && args?.op === "status") {
        return { ok: true, body: { running: false } };
      }
      throw new Error(`unexpected invoke ${cmd} ${JSON.stringify(args)}`);
    });

    const result = await runStaleCallAfterReconnectProbe();
    expect(result.ok).toBe(true);
    expect(result.stage).toBe("StaleCallAfterReconnect");
    expect(result.detail).toMatch(/launch B=launch-b/);
  });
});

const closeMock = vi.fn();
const destroyMock = vi.fn();
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    close: (...args: unknown[]) => closeMock(...args),
    destroy: (...args: unknown[]) => destroyMock(...args),
  }),
}));

describe("runNormalClosePendingProbe", () => {
  beforeEach(() => {
    invoke.mockReset();
    closeMock.mockReset();
    destroyMock.mockReset();
  });

  it("returns ok after window.close() without waiting or exiting", async () => {
    closeMock.mockResolvedValue(undefined);
    invoke.mockImplementation(async (cmd: string, args?: { op?: string }) => {
      if (cmd === "solver_engine_request" && args?.op === "values") {
        return { ok: true, body: {} };
      }
      if (cmd === "solver_engine_request" && args?.op === "status") {
        return { ok: true, body: { running: false } };
      }
      throw new Error(`unexpected invoke ${cmd}`);
    });
    const { runNormalClosePendingProbe } = await import("./ipcAcceptance");
    const result = await runNormalClosePendingProbe();
    expect(result.ok).toBe(true);
    expect(result.stage).toBe("NormalClosePending");
    expect(result.detail).toMatch(/window\.close\(\) accepted/);
    expect(destroyMock).not.toHaveBeenCalled();
  });

  it("falls back to destroy when close fails", async () => {
    closeMock.mockRejectedValue(new Error("close denied"));
    destroyMock.mockResolvedValue(undefined);
    invoke.mockImplementation(async (cmd: string, args?: { op?: string }) => {
      if (cmd === "solver_engine_request") return { ok: true, body: {} };
      throw new Error(`unexpected invoke ${cmd}`);
    });
    const { runNormalClosePendingProbe } = await import("./ipcAcceptance");
    const result = await runNormalClosePendingProbe();
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/destroy\(\) accepted/);
  });

  it("reports failure when both close and destroy fail", async () => {
    closeMock.mockRejectedValue(new Error("close denied"));
    destroyMock.mockRejectedValue(new Error("destroy denied"));
    invoke.mockImplementation(async (cmd: string, args?: { op?: string }) => {
      if (cmd === "solver_engine_request") return { ok: true, body: {} };
      throw new Error(`unexpected invoke ${cmd}`);
    });
    const { runNormalClosePendingProbe } = await import("./ipcAcceptance");
    const result = await runNormalClosePendingProbe();
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/close denied/);
    expect(result.detail).toMatch(/destroy denied/);
  });
});
