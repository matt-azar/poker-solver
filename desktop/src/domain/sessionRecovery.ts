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
 * After a cold reconnect the new sidecar has no in-memory train state.
 * Restart alone never restores unsaved progress (ZR-143) — only Open of a
 * previously saved checkpoint can.
 */
export function coldReconnectMessage(opts?: {
  label?: string;
  solutionPath?: string;
}): string {
  const base = reconnectedMessage(opts?.label);
  const path = opts?.solutionPath?.trim() ?? "";
  if (path) {
    return `${base} Unsaved train progress is gone. Open the last saved checkpoint (${path}) to restore it.`;
  }
  return `${base} Unsaved train progress is gone — Save before a crash to keep a checkpoint.`;
}

/** Last known on-disk checkpoint path Study can reopen after engine death. */
export function lastValidCheckpointPath(solutionPath: string | null | undefined): string {
  return (solutionPath ?? "").trim();
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

/** Sticky train/session fault code from status (`last_error` preferred, then `error`). */
export function statusStickyError(
  status: StatusPayload | null | undefined,
): string | null {
  if (!status) {
    return null;
  }
  if (typeof status.last_error === "string" && status.last_error.length > 0) {
    return status.last_error;
  }
  if (typeof status.error === "string" && status.error.length > 0) {
    return status.error;
  }
  return null;
}

/** True when status snapshot says the last train/session fault is sticky. */
export function statusIndicatesFailure(
  status: StatusPayload | null | undefined,
): boolean {
  if (!status) {
    return false;
  }
  const hostPhase =
    typeof status.phase === "string" ? status.phase.toLowerCase() : "";
  return Boolean(status.failed) || hostPhase === "failed" || statusStickyError(status) != null;
}

/**
 * How many consecutive soft status-poll failures before painting disconnected.
 * Hard session-dead faults (pipe closed / InvalidFrame) mark dead immediately.
 */
export const STATUS_POLL_DEAD_AFTER_FAILURES = 3;

/**
 * Decide whether a status-poll failure should paint Reconnect / unreachable.
 * Transient decode/timeout blips must not flicker "Engine unreachable" over a
 * healthy sidecar (ZR-148).
 */
export function shouldMarkStatusPollDead(args: {
  consecutiveFailures: number;
  detail: string;
  threshold?: number;
}): boolean {
  // Preconditions: failure counts are non-negative; threshold is at least 1.
  if (args.consecutiveFailures < 0) {
    throw new Error("contract: consecutiveFailures must be >= 0");
  }
  const threshold = args.threshold ?? STATUS_POLL_DEAD_AFTER_FAILURES;
  if (threshold < 1) {
    throw new Error("contract: status-poll dead threshold must be >= 1");
  }
  // Positive: hard session-dead faults paint immediately (even at 0 soft blips).
  if (isEngineSessionDead(args.detail)) {
    return true;
  }
  // Negative: soft blips stay alive until the threshold.
  return args.consecutiveFailures >= threshold;
}

/** True when store message is a disconnected / ensure-fail recovery string. */
export function isRecoveryOrUnreachableMessage(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes("engine unreachable") ||
    text.includes("reconnecting") ||
    text.includes("engine setup failed") ||
    text.includes("use reconnect")
  );
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
