import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("./index", () => ({
  isTauriRuntime: () => true,
}));

describe("diagnostics platform", () => {
  beforeEach(async () => {
    invoke.mockReset();
    const { resetSolveFaultDedupeForTests } = await import("./diagnostics");
    resetSolveFaultDedupeForTests();
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

  it("formatSolveFaultReason includes iter and board_len only", async () => {
    const { formatSolveFaultReason, boardLenFromStatusBoard } = await import(
      "./diagnostics"
    );
    expect(
      formatSolveFaultReason({
        reason: "OutOfMemory",
        iterations: 11,
        boardLen: 3,
      }),
    ).toBe("OutOfMemory (iter=11, board_len=3)");
    expect(boardLenFromStatusBoard(["Ah", "Kd", "7c"])).toBe(3);
    expect(boardLenFromStatusBoard("Ah Kd 7c 2s")).toBe(4);
    expect(boardLenFromStatusBoard(null)).toBeNull();
  });

  it("reportSolveFailedFault writes once per sticky key (ZR-163)", async () => {
    invoke.mockResolvedValue(undefined);
    const { reportSolveFailedFault } = await import("./diagnostics");
    await reportSolveFailedFault({
      reason: "OutOfMemory",
      exitReason: "solve-failed",
      iterations: 11,
      boardLen: 3,
      lastOp: "status",
    });
    await reportSolveFailedFault({
      reason: "OutOfMemory",
      exitReason: "solve-failed",
      iterations: 11,
      boardLen: 3,
      lastOp: "status",
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("report_engine_fault", {
      report: {
        reason: "OutOfMemory (iter=11, board_len=3)",
        exitReason: "solve-failed",
        lastOp: "status",
        consecutiveStatusFailures: undefined,
        protocol: 2,
      },
    });

    await reportSolveFailedFault({
      reason: "OutOfMemory",
      exitReason: "solve-failed",
      iterations: 12,
      boardLen: 3,
      lastOp: "status",
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
