import { afterEach, describe, expect, it, vi } from "vitest";
import { clearStudyIpcFeatureOverridesForTests } from "../engine/ipcCapabilities";
import { setNoEngineTransport, setIpcTransport } from "../engine/transport";
import { DEFAULT_SPOT, type SpotDraft } from "../domain/types";
import {
  canExecuteCalculateEv,
  canExecuteCompareToBaseline,
  canExecuteContinue,
  canExecuteLoadCategories,
  canExecuteOpenLockEditor,
  canExecuteOpenStrategyEditor,
  canExecuteResolveLocked,
  canExecuteSave,
  canExecuteSolve,
  executeOpenLockEditor,
  executeSolve,
  executeSolveAndOpenStudy,
  trainerContinueFromStatus,
  type StudyCommandContext,
} from "./studyCommands";

function ctx(
  partial: Partial<StudyCommandContext> & { draft?: SpotDraft } = {},
): StudyCommandContext {
  return {
    phase: "idle",
    draft: { ...DEFAULT_SPOT },
    solutionId: null,
    workspace: "build",
    currentNode: null,
    solveValidationErrors: [],
    ...partial,
  };
}

describe("canExecuteSolve", () => {
  it("allows Solve when idle with a valid draft", () => {
    const gate = canExecuteSolve(ctx());
    expect(gate.ok).toBe(true);
  });

  it("blocks Solve while the engine is already solving", () => {
    const gate = canExecuteSolve(ctx({ phase: "solving" }));
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/wait|stop/i);
  });

  it("blocks Solve when the live draft is incomplete", () => {
    const gate = canExecuteSolve(
      ctx({ draft: { ...DEFAULT_SPOT, boardText: "" } }),
    );
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/board/i);
  });

  it("unblocks after a manual board completes an incomplete draft", () => {
    const incomplete = canExecuteSolve(
      ctx({ draft: { ...DEFAULT_SPOT, boardText: "" } }),
    );
    expect(incomplete.ok).toBe(false);
    const complete = canExecuteSolve(
      ctx({ draft: { ...DEFAULT_SPOT, boardText: "As 7d 2c" } }),
    );
    expect(complete.ok).toBe(true);
  });
});

describe("canExecuteSave / Calculate EV / lock / strategy", () => {
  it("requires a published solution for Save", () => {
    expect(canExecuteSave(ctx()).ok).toBe(false);
    expect(canExecuteSave(ctx({ solutionId: "s1" })).ok).toBe(true);
  });

  it("guards Calculate EV to decision nodes with a solution", () => {
    expect(canExecuteCalculateEv(ctx()).ok).toBe(false);
    expect(
      canExecuteCalculateEv(
        ctx({
          solutionId: "s1",
          currentNode: { node_id: "root", kind: "chance" },
        }),
      ).ok,
    ).toBe(false);
    expect(
      canExecuteCalculateEv(
        ctx({
          solutionId: "s1",
          currentNode: { node_id: "p0", kind: "decision" },
        }),
      ).ok,
    ).toBe(true);
  });

  it("requires Study workspace and a decision node for lock/strategy editors", () => {
    const decision = { node_id: "p0", kind: "decision" as const };
    expect(
      canExecuteOpenLockEditor(
        ctx({ solutionId: "s1", currentNode: decision, workspace: "build" }),
      ).ok,
    ).toBe(false);
    expect(
      canExecuteOpenStrategyEditor(
        ctx({ solutionId: "s1", currentNode: decision, workspace: "build" }),
      ).ok,
    ).toBe(false);
    expect(
      canExecuteOpenLockEditor(
        ctx({ solutionId: "s1", currentNode: decision, workspace: "study" }),
      ).ok,
    ).toBe(true);
    expect(
      canExecuteOpenStrategyEditor(
        ctx({ solutionId: "s1", currentNode: decision, workspace: "study" }),
      ).ok,
    ).toBe(true);
  });

  it("Continue needs a published solution even when phase allows it", () => {
    expect(canExecuteContinue(ctx({ phase: "paused" })).ok).toBe(false);
    expect(
      canExecuteContinue(ctx({ phase: "paused", solutionId: "s1" })).ok,
    ).toBe(true);
  });

  it("disables Continue for browse-only (no trainer) even when complete", () => {
    const gate = canExecuteContinue(
      ctx({
        phase: "complete",
        solutionId: "s1",
        canContinueTraining: false,
      }),
    );
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/browse-only|trainer/i);
  });

  it("keeps Continue when host reports can_continue", () => {
    expect(
      canExecuteContinue(
        ctx({
          phase: "complete",
          solutionId: "s1",
          canContinueTraining: true,
        }),
      ).ok,
    ).toBe(true);
  });

  it("trainerContinueFromStatus prefers can_continue over has_training", () => {
    expect(trainerContinueFromStatus(null)).toBeNull();
    expect(trainerContinueFromStatus({})).toBeNull();
    expect(
      trainerContinueFromStatus({
        running: false,
        paused: false,
        cancelled: false,
        status_generation: 1,
        can_continue: false,
        has_training: true,
      }),
    ).toBe(false);
    expect(
      trainerContinueFromStatus({
        running: false,
        paused: false,
        cancelled: false,
        status_generation: 1,
        has_training: true,
      }),
    ).toBe(true);
  });
});

describe("IPC soft-disable gates (ZR-102)", () => {
  afterEach(() => {
    clearStudyIpcFeatureOverridesForTests();
    setNoEngineTransport();
  });

  it("allows Resolve locked + Categories + strategy edits; keeps compare soft-disabled", () => {
    setIpcTransport({
      protocol: 2,
      launchId: "test",
      sidecar: "solver-engine",
      workers: 1,
    });
    const decision = { node_id: "p0", kind: "decision" as const };
    const study = ctx({
      solutionId: "s1",
      currentNode: decision,
      workspace: "study",
    });
    expect(canExecuteResolveLocked(study).ok).toBe(true);
    expect(canExecuteCompareToBaseline(study).ok).toBe(false);
    // ZR-101 (#303) enabled strategy edits over IPC.
    expect(canExecuteOpenStrategyEditor(study).ok).toBe(true);
    expect(canExecuteLoadCategories(study).ok).toBe(true);
  });
});

describe("executeSolve / executeSolveAndOpenStudy", () => {
  it("does not call solve when eligibility fails", async () => {
    const solve = vi.fn(async () => undefined);
    const result = await executeSolve({
      getContext: () => ctx({ phase: "solving" }),
      solve,
    });
    expect(result.ok).toBe(false);
    expect(solve).not.toHaveBeenCalled();
  });

  it("does not navigate when engine launch fails", async () => {
    let phase: StudyCommandContext["phase"] = "idle";
    const setWorkspace = vi.fn();
    const solve = vi.fn(async () => {
      phase = "failed";
    });
    const result = await executeSolveAndOpenStudy({
      getContext: () => ctx({ phase, solveValidationErrors: [] }),
      solve,
      setWorkspace,
    });
    expect(result.ok).toBe(false);
    expect(setWorkspace).not.toHaveBeenCalled();
  });

  it("navigates to Study only after a successful launch", async () => {
    let phase: StudyCommandContext["phase"] = "idle";
    const setWorkspace = vi.fn();
    const solve = vi.fn(async () => {
      phase = "solving";
    });
    const result = await executeSolveAndOpenStudy({
      getContext: () => ctx({ phase, solveValidationErrors: [] }),
      solve,
      setWorkspace,
    });
    expect(result.ok).toBe(true);
    expect(setWorkspace).toHaveBeenCalledWith("study");
  });

  it("does not open the lock editor outside Study", () => {
    const setLockDrawerOpen = vi.fn();
    const result = executeOpenLockEditor({
      getContext: () =>
        ctx({
          workspace: "build",
          solutionId: "s1",
          currentNode: { node_id: "p0", kind: "decision" },
        }),
      setLockDrawerOpen,
    });
    expect(result.ok).toBe(false);
    expect(setLockDrawerOpen).not.toHaveBeenCalled();
  });
});
