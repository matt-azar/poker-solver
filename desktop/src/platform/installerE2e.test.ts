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

describe("runInstallerE2eStageB", () => {
  it("stays gated / scaffold-only", async () => {
    const { runInstallerE2eStageB } = await import("./installerE2e");
    const result = await runInstallerE2eStageB();
    expect(result.ok).toBe(false);
    expect(result.lastCompletedStep).toBe("stage-b-gated");
  });
});
