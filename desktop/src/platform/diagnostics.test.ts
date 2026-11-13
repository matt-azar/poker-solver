import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SolveJobRequest } from "../domain/types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("./index", () => ({
  isTauriRuntime: () => true,
}));

function sampleJob(overrides: Partial<SolveJobRequest> = {}): SolveJobRequest {
  return {
    board: ["Ah", "Kd", "7c"],
    oop_range: "AA,KK",
    ip_range: "QQ",
    pot: 100,
    stack: 1000,
    oop_bets: [0.5],
    ip_bets: [0.75],
    oop_flop_bets: [0.33],
    iterations: 50,
    accuracy: 0.005,
    memory_mib: 2048,
    threads: 4,
    algorithm: "cfr_plus",
    frozen: 1,
    samples: 5,
    rake_rate: 0,
    rake_cap: 0,
    ...overrides,
  };
}

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

  it("formatSolveFaultReason includes iter, board_len, and peak", async () => {
    const { formatSolveFaultReason, boardLenFromStatusBoard } = await import(
      "./diagnostics"
    );
    expect(
      formatSolveFaultReason({
        reason: "StrategyPublishFailed",
        iterations: 11,
        boardLen: 3,
        enginePeak: 400 * 1024 * 1024,
        engineAllocated: 350 * 1024 * 1024,
      }),
    ).toBe(
      "StrategyPublishFailed (iter=11, board_len=3, peak=400.0MiB, alloc=350.0MiB)",
    );
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

  it("summarizeLastSolve omits range blobs and labels pre-solve (ZR-169)", async () => {
    const {
      summarizeLastSolve,
      compactTextHash,
      persistPreSolveDiagnostics,
      summarizeContinueSolve,
    } = await import("./diagnostics");
    const summary = summarizeLastSolve(sampleJob(), "solve");
    expect(summary.snapshotKind).toBe("pre-solve");
    expect(summary.trigger).toBe("solve");
    expect(summary.street).toBe("flop");
    expect(summary.board).toEqual(["Ah", "Kd", "7c"]);
    expect(summary.memoryMib).toBe(2048);
    expect(summary.threads).toBe(4);
    expect(summary.publishEveryHint).toBe(10);
    expect(summary.betSizes.oop_flop_bets).toEqual([0.33]);
    expect(summary.ranges.oop.hash).toBe(compactTextHash("AA,KK"));
    expect(summary.ranges.oop.chars).toBe(5);
    expect(JSON.stringify(summary)).not.toMatch(/AA,KK/);

    invoke.mockResolvedValue(undefined);
    await persistPreSolveDiagnostics(summary);
    expect(invoke).toHaveBeenCalledWith("persist_pre_solve_diagnostics", {
      summary,
    });

    const continued = summarizeContinueSolve(null, {
      iterations: 25,
      timeLimit: 60,
    });
    expect(continued?.trigger).toBe("continue");
    expect(continued?.iterations).toBe(25);
    expect(continued?.timeLimit).toBe(60);
    expect(continued?.board).toEqual(["Ah", "Kd", "7c"]);
  });

  it("persistPreSolveDiagnostics swallows invoke errors", async () => {
    invoke.mockRejectedValueOnce(new Error("no tauri"));
    const { persistPreSolveDiagnostics, summarizeLastSolve } = await import(
      "./diagnostics"
    );
    await expect(
      persistPreSolveDiagnostics(summarizeLastSolve(sampleJob())),
    ).resolves.toBeUndefined();
  });
});