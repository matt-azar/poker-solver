import type { SolvePhase } from "./types";

export interface SolveControlFlags {
  canSolve: boolean;
  canContinue: boolean;
  canPause: boolean;
  canStop: boolean;
  busy: boolean;
}

/**
 * Which Solve toolbar actions are legal for the current engine phase.
 * Only one of Solve / Continue should look available while idle-or-paused;
 * Pause/Stop only while work is in flight.
 */
export function solveControlFlags(phase: SolvePhase): SolveControlFlags {
  const busy = phase === "solving" || phase === "building";
  const pausing = phase === "pause_requested";
  const stopping = phase === "stop_requested";
  const canContinue = phase === "paused" || phase === "complete";
  const canSolve =
    phase === "idle" ||
    phase === "complete" ||
    phase === "failed" ||
    phase === "paused";
  return {
    busy,
    canSolve: canSolve && !busy && !pausing && !stopping,
    canContinue: canContinue && !busy && !pausing && !stopping,
    canPause: busy,
    canStop: busy || pausing,
  };
}
