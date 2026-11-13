import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("./index", () => ({
  isTauriRuntime: () => true,
}));

describe("diagnostics platform", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("openDiagnosticsFolder invokes Tauri command", async () => {
    invoke.mockResolvedValueOnce("C:\\Users\\x\\AppData\\Local\\Holdem Study\\diagnostics");
    const { openDiagnosticsFolder } = await import("./diagnostics");
    const path = await openDiagnosticsFolder();
    expect(invoke).toHaveBeenCalledWith("open_diagnostics_folder");
    expect(path).toMatch(/diagnostics/i);
  });

  it("copyDiagnosticsBundle returns zip path", async () => {
    invoke.mockResolvedValueOnce("C:\\tmp\\holdem-study-diagnostics-1.zip");
    const { copyDiagnosticsBundle } = await import("./diagnostics");
    const path = await copyDiagnosticsBundle();
    expect(invoke).toHaveBeenCalledWith("copy_diagnostics_bundle");
    expect(path).toMatch(/\.zip$/i);
  });

  it("reportEngineFault is best-effort and does not throw", async () => {
    invoke.mockRejectedValueOnce(new Error("offline"));
    const { reportEngineFault } = await import("./diagnostics");
    await expect(
      reportEngineFault({ reason: "pipe closed", lastOp: "status" }),
    ).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("report_engine_fault", {
      report: { reason: "pipe closed", lastOp: "status" },
    });
  });
});
