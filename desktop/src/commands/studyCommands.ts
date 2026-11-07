import { validateSetupForSolve } from "../domain/setup";
import { solveControlFlags } from "../domain/solveControls";
import type { NodePayload, SolvePhase, SpotDraft } from "../domain/types";

export type StudyWorkspaceId = "study" | "build" | "compare" | "library" | "equity";

export interface StudyCommandContext {
  phase: SolvePhase;
  draft: SpotDraft;
  solutionId: string | null;
  workspace: StudyWorkspaceId;
  currentNode: NodePayload | null;
  /** Cleared on successful launch; nonempty after client validation failure. */
  solveValidationErrors?: string[];
}

export interface CommandEligibility {
  ok: boolean;
  reason: string;
}

export interface CommandResult {
  ok: boolean;
  reason?: string;
}

function eligible(ok: boolean, reason: string): CommandEligibility {
  return { ok, reason };
}

/** Shared Solve availability: engine phase + live draft validation. */
export function canExecuteSolve(ctx: StudyCommandContext): CommandEligibility {
  const flags = solveControlFlags(ctx.phase);
  if (!flags.canSolve) {
    return eligible(
      false,
      "Stop or wait for the current solve before starting another",
    );
  }
  const validation = validateSetupForSolve(ctx.draft);
  if (!validation.ok) {
    return eligible(
      false,
      validation.errors[0] ?? "Finish missing setup fields before solving",
    );
  }
  return eligible(true, "Start a new solve from the current build settings");
}

export function canExecuteContinue(ctx: StudyCommandContext): CommandEligibility {
  const flags = solveControlFlags(ctx.phase);
  if (!flags.canContinue) {
    return eligible(
      false,
      "Continue is available after Pause, Stop, or Complete",
    );
  }
  if (!ctx.solutionId) {
    return eligible(false, "Solve first");
  }
  return eligible(true, "Resume or add iterations to the current solution");
}

export function canExecutePause(ctx: StudyCommandContext): CommandEligibility {
  const flags = solveControlFlags(ctx.phase);
  if (!flags.canPause) {
    return eligible(false, "Nothing is solving");
  }
  return eligible(true, "Pause after the current sample");
}

export function canExecuteStop(ctx: StudyCommandContext): CommandEligibility {
  const flags = solveControlFlags(ctx.phase);
  if (!flags.canStop) {
    return eligible(false, "Nothing is solving");
  }
  return eligible(true, "Stop and keep completed iterations");
}

export function canExecuteSave(ctx: StudyCommandContext): CommandEligibility {
  if (!ctx.solutionId) {
    return eligible(false, "Solve first — Save needs a published solution");
  }
  return eligible(true, "Save the current solution");
}

export function canExecuteCalculateEv(
  ctx: StudyCommandContext,
): CommandEligibility {
  if (!ctx.solutionId) {
    return eligible(false, "Solve first");
  }
  if (!ctx.currentNode) {
    return eligible(false, "Select a node before calculating EV");
  }
  if (ctx.currentNode.kind !== "decision") {
    return eligible(
      false,
      "Action EV is only available at decision nodes",
    );
  }
  const flags = solveControlFlags(ctx.phase);
  if (flags.busy) {
    return eligible(false, "Wait for the current solve to finish");
  }
  return eligible(true, "Compute action EVs for the current node");
}

export function canExecuteOpenLockEditor(
  ctx: StudyCommandContext,
): CommandEligibility {
  if (ctx.workspace !== "study") {
    return eligible(false, "Open Study to edit locks");
  }
  if (!ctx.solutionId) {
    return eligible(false, "Solve first");
  }
  if (!ctx.currentNode || ctx.currentNode.kind !== "decision") {
    return eligible(false, "Locks require a decision node");
  }
  return eligible(true, "Open Node Locking for the current decision");
}

export function canExecuteOpenStrategyEditor(
  ctx: StudyCommandContext,
): CommandEligibility {
  if (ctx.workspace !== "study") {
    return eligible(false, "Open Study to edit strategy");
  }
  if (!ctx.solutionId) {
    return eligible(false, "Solve first");
  }
  if (!ctx.currentNode || ctx.currentNode.kind !== "decision") {
    return eligible(false, "Strategy edits require a decision node");
  }
  return eligible(true, "Open the strategy editor for the current decision");
}

export interface SolveCommandDeps {
  getContext: () => StudyCommandContext;
  solve: () => Promise<void>;
  /** Called only after a confirmed successful engine launch. */
  onLaunched?: () => void;
}

/**
 * Run Solve after eligibility. Does not navigate on validation or launch
 * failure — callers that open Study must use {@link executeSolveAndOpenStudy}.
 */
export async function executeSolve(
  deps: SolveCommandDeps,
): Promise<CommandResult> {
  const before = deps.getContext();
  const gate = canExecuteSolve(before);
  if (!gate.ok) {
    return { ok: false, reason: gate.reason };
  }
  await deps.solve();
  const after = deps.getContext();
  if ((after.solveValidationErrors?.length ?? 0) > 0) {
    return {
      ok: false,
      reason:
        after.solveValidationErrors?.[0] ??
        "Finish missing setup fields before solving",
    };
  }
  if (after.phase === "failed") {
    return { ok: false, reason: "Solve failed to launch" };
  }
  deps.onLaunched?.();
  return { ok: true };
}

/**
 * Build's Solve & open Study: navigate only after a confirmed successful launch.
 */
export async function executeSolveAndOpenStudy(
  deps: SolveCommandDeps & { setWorkspace: (id: StudyWorkspaceId) => void },
): Promise<CommandResult> {
  const result = await executeSolve({
    ...deps,
    onLaunched: () => {
      deps.setWorkspace("study");
      deps.onLaunched?.();
    },
  });
  return result;
}

export interface SimpleCommandDeps {
  getContext: () => StudyCommandContext;
}

export async function executeContinue(
  deps: SimpleCommandDeps & { continueSolve: () => Promise<void> },
): Promise<CommandResult> {
  const gate = canExecuteContinue(deps.getContext());
  if (!gate.ok) {
    return { ok: false, reason: gate.reason };
  }
  await deps.continueSolve();
  return { ok: true };
}

export async function executePause(
  deps: SimpleCommandDeps & { pause: () => Promise<void> },
): Promise<CommandResult> {
  const gate = canExecutePause(deps.getContext());
  if (!gate.ok) {
    return { ok: false, reason: gate.reason };
  }
  await deps.pause();
  return { ok: true };
}

export async function executeStop(
  deps: SimpleCommandDeps & { stop: () => Promise<void> },
): Promise<CommandResult> {
  const gate = canExecuteStop(deps.getContext());
  if (!gate.ok) {
    return { ok: false, reason: gate.reason };
  }
  await deps.stop();
  return { ok: true };
}

export async function executeCalculateEv(
  deps: SimpleCommandDeps & { calculateEv: () => Promise<void> },
): Promise<CommandResult> {
  const gate = canExecuteCalculateEv(deps.getContext());
  if (!gate.ok) {
    return { ok: false, reason: gate.reason };
  }
  await deps.calculateEv();
  return { ok: true };
}

export async function executeSave(
  deps: SimpleCommandDeps & { save: () => Promise<void | boolean> },
): Promise<CommandResult> {
  const gate = canExecuteSave(deps.getContext());
  if (!gate.ok) {
    return { ok: false, reason: gate.reason };
  }
  await deps.save();
  return { ok: true };
}

export function executeOpenLockEditor(
  deps: SimpleCommandDeps & { setLockDrawerOpen: (open: boolean) => void },
): CommandResult {
  const gate = canExecuteOpenLockEditor(deps.getContext());
  if (!gate.ok) {
    return { ok: false, reason: gate.reason };
  }
  deps.setLockDrawerOpen(true);
  return { ok: true };
}

export function executeOpenStrategyEditor(
  deps: SimpleCommandDeps & {
    setStrategyEditDrawerOpen: (open: boolean) => void;
  },
): CommandResult {
  const gate = canExecuteOpenStrategyEditor(deps.getContext());
  if (!gate.ok) {
    return { ok: false, reason: gate.reason };
  }
  deps.setStrategyEditDrawerOpen(true);
  return { ok: true };
}

/** Snapshot store fields used by command eligibility. */
export function studyCommandContextFromStore(state: {
  phase: SolvePhase;
  draft: SpotDraft;
  solutionId: string | null;
  workspace: StudyWorkspaceId;
  currentNode: NodePayload | null;
  solveValidationErrors: string[];
}): StudyCommandContext {
  return {
    phase: state.phase,
    draft: state.draft,
    solutionId: state.solutionId,
    workspace: state.workspace,
    currentNode: state.currentNode,
    solveValidationErrors: state.solveValidationErrors,
  };
}
