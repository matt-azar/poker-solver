/**
 * Durable Study session recovery (ZR-123).
 *
 * One architecture path for sidecar death, InvalidFrame/pipe faults, sticky
 * busy/cancel UI, ensure-fail, and host phase=failed — not scattered try/catch
 * bandaids. Callers mark the session dead or run `recoverEngineSession`; they
 * do not invent one-off reconnect logic.
 */

import type { SolvePhase, StatusPayload } from "./types";

/** True when the IPC session/pipe is dead and Study must re-ensure. */
export function isEngineSessionDead(detail: string): boolean {
  const text = detail.toLowerCase();
  return (
    text.includes("pipe closed") ||
    text.includes("broken pipe") ||
    text.includes("shut down") ||
    text.includes("session killed") ||
    text.includes("session shut down") ||
    text.includes("engine unreachable") ||
    text.includes("invalidframe") ||
    text.includes("invalid_frame") ||
    text.includes("solver-engine exiting") ||
    text.includes("sidecar_exit") ||
    text.includes("not started") ||
    text.includes("stdin lock poisoned") ||
    text.includes("write:")
  );
}

export function classifyEngineSessionFault(error: unknown): {
  sessionDead: boolean;
  detail: string;
} {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "engine fault";
  const detail = raw.trim() || "engine fault";
  return { sessionDead: isEngineSessionDead(detail), detail };
}

/** UI phases that block Solve/Continue until recovery clears them. */
export function isStickyBusyPhase(phase: SolvePhase): boolean {
  return (
    phase === "solving" ||
    phase === "building" ||
    phase === "pause_requested" ||
    phase === "stop_requested" ||
    phase === "saving" ||
    phase === "loading" ||
    phase === "analysis_pending"
  );
}

/**
 * After pipe death / ensure-fail: clear sticky busy/cancel so Solve is legal.
 * Keep published study identity; phase becomes recoverable `failed` or `idle`.
 */
export function phaseAfterSessionFault(
  prior: SolvePhase,
  opts?: { hadSolution?: boolean },
): SolvePhase {
  if (isStickyBusyPhase(prior) || prior === "failed") {
    return opts?.hadSolution ? "failed" : "idle";
  }
  return prior;
}

export function disconnectedRecoveryMessage(detail: string): string {
  const cleaned = detail.trim() || "engine unreachable";
  return `Engine unreachable: ${cleaned}. Use Reconnect — Study will re-ensure the local solver-engine.`;
}

export function ensureFailedRecoveryMessage(detail: string): string {
  const cleaned = detail.trim() || "ensure failed";
  return `Engine setup failed: ${cleaned}. Sticky solve state was cleared — try Reconnect, then Solve.`;
}

export function reconnectingMessage(): string {
  return "Reconnecting — re-ensuring local solver-engine…";
}

export function reconnectedMessage(label?: string): string {
  return label?.trim()
    ? `Engine reconnected (${label}).`
    : "Engine reconnected.";
}

/**
 * Host status publishes `phase:"failed"`; desktop historically only looked at
 * `failed`/`error`. Normalize so phase mapping is honest.
 */
export function normalizeStatusForPhase(status: StatusPayload): StatusPayload {
  const hostPhase = typeof status.phase === "string" ? status.phase : null;
  if (hostPhase === "failed" && !status.failed) {
    return { ...status, failed: true };
  }
  return status;
}

/**
 * Patch applied when marking the engine unreachable (status poll, Apply, stop).
 * Clears sticky busy/cancel; does not re-ensure (Reconnect / recover does).
 */
export function sessionDeadUiPatch(args: {
  detail: string;
  phase: SolvePhase;
  solutionId: string | null;
}): {
  connection: "disconnected";
  phase: SolvePhase;
  message: string;
} {
  return {
    connection: "disconnected",
    phase: phaseAfterSessionFault(args.phase, {
      hadSolution: Boolean(args.solutionId),
    }),
    message: disconnectedRecoveryMessage(args.detail),
  };
}
