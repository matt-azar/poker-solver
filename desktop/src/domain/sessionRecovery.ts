/**
 * Durable Study session recovery (ZR-123).
 *
 * One architecture path for sidecar death, InvalidFrame/pipe faults, sticky
 * busy/cancel UI, ensure-fail, and host phase=failed — not scattered try/catch
 * bandaids. Callers mark the session dead or run `recoverEngineSession`; they
 * do not invent one-off reconnect logic.
 *
 * IPC audit §3 (2026-11-18): congestion / soft status timeouts / Ready-probe
 * errors must not terminate a healthy child while Solving or with unsaved
 * Complete solutions. Typed error class / phase / origin are preserved when
 * present on EngineError-like inputs.
 */

import type { SolvePhase } from "./types";
import type { StatusPayload } from "./types";

/** Typed Rust `IpcError` classes (mirrored; domain must not import engine/). */
export type IpcFaultClass =
  | "queue_saturation"
  | "timeout"
  | "engine_rejection"
  | "protocol_failure"
  | "connection_loss"
  | "unknown";

/**
 * Duck-typed EngineError / SolverIpcError fields the policy may read.
 * Callers can pass the thrown error object; unknown shapes fall back to text.
 */
export type EngineFaultLike = {
  message?: string;
  detail?: string;
  /** SolverIpcError.ipcClass */
  ipcClass?: string | null;
  /** Serde envelope `class` */
  class?: string | null;
  errorClass?: string | null;
  /** Timeout phase (`before_write` / `after_write`) or host phase when present. */
  phase?: string | null;
  origin?: string | null;
  op?: string | null;
  requestId?: string | null;
  request_id?: string | null;
  launchId?: string | null;
  launch_id?: string | null;
  degraded?: boolean;
  errorCode?: string | null;
  error_code?: string | null;
};

/** Normalized fault view — preserves typed fields when present. */
export type ClassifiedEngineFault = {
  detail: string;
  faultClass: IpcFaultClass;
  /** True when faultClass came from a typed field, not text heuristics. */
  classFromTypedField: boolean;
  phase: string | null;
  origin: string | null;
  op: string | null;
  requestId: string | null;
  launchId: string | null;
  degraded: boolean;
  errorCode: string | null;
  sessionDead: boolean;
  congestion: boolean;
  softTimeout: boolean;
};

export type StatusPollRecoveryReason =
  | "hard_session_dead"
  | "hung_threshold"
  | "congestion_backoff"
  | "soft_timeout_preserve"
  | "below_threshold";

/**
 * Clear status-poll policy decision for Study watchdog wire-up.
 * Prefer this over composing mark-dead + terminate independently.
 */
export type StatusPollRecoveryDecision = {
  markDead: boolean;
  terminate: boolean;
  reason: StatusPollRecoveryReason;
  fault: ClassifiedEngineFault;
};

export type ReadyProbeObservation =
  | "process_exit"
  | "failed_connection"
  | "missed_observation"
  | "congestion"
  | "engine_rejection"
  | "unknown";

/**
 * Ready / ensure probe against an already-running child.
 * Timeout and admission must not auto-teardown; missing class fails closed
 * toward preserve + explicit restart semantics.
 */
export type ReadyProbeRecoveryDecision = {
  /** Tear down the existing connection / child. */
  teardown: boolean;
  /** Offer an explicit Restart (unsaved work may be lost) — never silent. */
  explicitRestart: boolean;
  /** Keep the existing child; treat as backoff / missed observation. */
  preserve: boolean;
  observation: ReadyProbeObservation;
  reason: string;
  fault: ClassifiedEngineFault;
};

const IPC_FAULT_CLASSES: ReadonlySet<string> = new Set([
  "queue_saturation",
  "timeout",
  "engine_rejection",
  "protocol_failure",
  "connection_loss",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function readStringField(
  record: Record<string, unknown> | null,
  ...keys: string[]
): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return null;
}

function normalizeIpcFaultClass(raw: string | null | undefined): IpcFaultClass | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (IPC_FAULT_CLASSES.has(trimmed)) {
    return trimmed as IpcFaultClass;
  }
  return null;
}

/** Extract a typed class from EngineError-like / SolverIpcError-like inputs. */
export function readTypedIpcFaultClass(input: unknown): IpcFaultClass | null {
  if (input == null) return null;
  if (typeof input === "string") return null;
  const record = asRecord(input);
  if (!record) return null;
  return (
    normalizeIpcFaultClass(
      typeof record.ipcClass === "string" ? record.ipcClass : null,
    ) ??
    normalizeIpcFaultClass(typeof record.class === "string" ? record.class : null) ??
    normalizeIpcFaultClass(
      typeof record.errorClass === "string" ? record.errorClass : null,
    ) ??
    normalizeIpcFaultClass(
      typeof record.error_class === "string" ? record.error_class : null,
    )
  );
}

/** Infer class from detail text when no typed field is present. */
export function inferIpcFaultClassFromDetail(detail: string): IpcFaultClass {
  const text = detail.toLowerCase();
  if (
    text.includes("connection_loss") ||
    text.includes("pipe closed") ||
    text.includes("broken pipe") ||
    text.includes("sidecar_exit") ||
    text.includes("solver-engine exiting") ||
    text.includes("session killed") ||
    text.includes("session shut down")
  ) {
    return "connection_loss";
  }
  if (isAdmissionSaturationDetail(detail)) {
    return "queue_saturation";
  }
  if (isSoftRpcTimeoutDetail(detail)) {
    return "timeout";
  }
  if (text.includes("invalidframe") || text.includes("invalid_frame") || text.includes("malformed ipc")) {
    return "protocol_failure";
  }
  return "unknown";
}

/**
 * True when the IPC session/pipe is dead and Study must re-ensure.
 * Congestion / soft timeouts are intentionally excluded.
 */
export function isEngineSessionDead(detail: string): boolean {
  const text = detail.toLowerCase();
  return (
    text.includes("connection_loss") ||
    text.includes("pipe closed") ||
    text.includes("broken pipe") ||
    text.includes("shut down") ||
    text.includes("session killed") ||
    text.includes("session shut down") ||
    text.includes("engine unreachable") ||
    text.includes("no engine url") ||
    text.includes("ipc not connected") ||
    text.includes("invalidframe") ||
    text.includes("invalid_frame") ||
    text.includes("malformed ipc") ||
    text.includes("solver-engine exiting") ||
    text.includes("sidecar_exit") ||
    text.includes("not started") ||
    text.includes("stdin lock poisoned") ||
    text.includes("write:")
  );
}

/** Admission / queue saturation — congestion, not process death. */
export function isAdmissionSaturationDetail(detail: string): boolean {
  const text = detail.toLowerCase();
  return (
    text.includes("admission saturated") ||
    text.includes("queue_saturation") ||
    text.includes("queue saturation") ||
    text.includes("queued bytes")
  );
}

export function isCongestionFault(fault: Pick<ClassifiedEngineFault, "faultClass" | "detail" | "congestion">): boolean {
  return fault.congestion || fault.faultClass === "queue_saturation" || isAdmissionSaturationDetail(fault.detail);
}

/**
 * Normalize an EngineError-like / string / unknown into a classified fault,
 * preserving typed class / phase / origin / launch when present.
 */
export function classifyEngineFault(input: unknown): ClassifiedEngineFault {
  const record = asRecord(input);
  const typedClass = readTypedIpcFaultClass(input);
  const detailFromFields =
    (typeof record?.detail === "string" && record.detail.trim()) ||
    (typeof record?.message === "string" && record.message.trim()) ||
    "";
  const detail =
    detailFromFields ||
    (input instanceof Error
      ? input.message.trim()
      : typeof input === "string"
        ? input.trim()
        : "") ||
    "engine fault";

  const faultClass = typedClass ?? inferIpcFaultClassFromDetail(detail);
  const congestion =
    faultClass === "queue_saturation" || isAdmissionSaturationDetail(detail);
  const softTimeout =
    faultClass === "timeout" || (!congestion && isSoftRpcTimeoutDetail(detail));
  const sessionDead =
    faultClass === "connection_loss" ||
    (faultClass === "protocol_failure" && isEngineSessionDead(detail)) ||
    (!typedClass && !congestion && !softTimeout && isEngineSessionDead(detail));

  return {
    detail,
    faultClass,
    classFromTypedField: typedClass != null,
    phase: readStringField(record, "phase"),
    origin: readStringField(record, "origin"),
    op: readStringField(record, "op"),
    requestId: readStringField(record, "requestId", "request_id"),
    launchId: readStringField(record, "launchId", "launch_id"),
    degraded: record?.degraded === true,
    errorCode: readStringField(record, "errorCode", "error_code"),
    sessionDead,
    congestion,
    softTimeout,
  };
}

export function classifyEngineSessionFault(error: unknown): {
  sessionDead: boolean;
  detail: string;
} {
  const fault = classifyEngineFault(error);
  return { sessionDead: fault.sessionDead, detail: fault.detail };
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
 * previously saved checkpoint can. ZR-157 surfaces that as Reopen last
 * checkpoint (backed by last successful Save or Open), not path-only copy.
 */
export function coldReconnectMessage(opts?: {
  label?: string;
  solutionPath?: string;
}): string {
  const base = reconnectedMessage(opts?.label);
  const path = opts?.solutionPath?.trim() ?? "";
  if (path) {
    return `${base} Unsaved train progress is gone. Use Reopen last checkpoint to restore ${path}.`;
  }
  return `${base} Unsaved train progress is gone — Save before a crash to keep a checkpoint.`;
}

/**
 * Last known on-disk checkpoint Study can reopen after engine death.
 * Prefer the dedicated last-successful Save/Open path; fall back to the
 * draft field only for recovery copy when older sessions never recorded one.
 */
export function lastValidCheckpointPath(
  solutionPath: string | null | undefined,
  lastSuccessfulPath?: string | null | undefined,
): string {
  const successful = (lastSuccessfulPath ?? "").trim();
  if (successful) {
    return successful;
  }
  return (solutionPath ?? "").trim();
}

/**
 * True when Study can offer Reopen last checkpoint.
 * Only a successful Save/Open path qualifies — typed draft paths do not.
 */
export function canOfferReopenLastCheckpoint(
  lastCheckpointPath: string | null | undefined,
): boolean {
  return (lastCheckpointPath ?? "").trim().length > 0;
}

/**
 * Host status publishes `phase:"failed"`; desktop historically only looked at
 * `failed`/`error`. Normalize so phase mapping is honest.
 *
 * ZR-171: also alias Zig heap fields onto the Study footer metrics keys so
 * Acc/ETA/Mem light up without every call site knowing both names.
 */
export function normalizeStatusForPhase(status: StatusPayload): StatusPayload {
  const hostPhase = typeof status.phase === "string" ? status.phase : null;
  let next: StatusPayload = status;
  if (hostPhase === "failed" && !status.failed) {
    next = { ...next, failed: true };
  }
  const allocated =
    status.engine_allocated ??
    status.engine_heap_bytes ??
    (typeof status.allocated_bytes === "number" ? status.allocated_bytes : null);
  const peak =
    status.engine_peak ??
    (typeof status.peak_allocated_bytes === "number"
      ? status.peak_allocated_bytes
      : null);
  if (allocated != null && status.engine_allocated == null) {
    next = { ...next, engine_allocated: Number(allocated) };
  }
  if (allocated != null && status.engine_heap_bytes == null) {
    next = { ...next, engine_heap_bytes: Number(allocated) };
  }
  if (peak != null && status.engine_peak == null) {
    next = { ...next, engine_peak: Number(peak) };
  }
  if (
    status.accuracy_chips == null &&
    typeof status.nash_gap === "number" &&
    Number.isFinite(status.nash_gap)
  ) {
    next = { ...next, accuracy_chips: 0.5 * status.nash_gap };
  }
  if (
    (status.player0_expected_utility == null ||
      Number.isNaN(Number(status.player0_expected_utility))) &&
    typeof status.value === "number" &&
    Number.isFinite(status.value)
  ) {
    next = { ...next, player0_expected_utility: status.value };
  }
  return next;
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
 * Soft status timeouts / congestion during these phases must not paint
 * disconnected or kill the sidecar. Packaged flop build/train can CPU-saturate
 * Windows so status exceeds the poll budget while the engine is healthy.
 * Complete is included so an unsaved published solution is not torn down by
 * ordinary late polls (IPC audit §3).
 */
export function softStatusTimeoutPreservesSession(phase: SolvePhase): boolean {
  return (
    phase === "building" ||
    phase === "solving" ||
    phase === "pause_requested" ||
    phase === "stop_requested" ||
    phase === "analysis_pending" ||
    phase === "complete"
  );
}

type StatusPollPolicyArgs = {
  consecutiveFailures: number;
  detail: string;
  threshold?: number;
  /** Current Study phase — soft timeouts preserve session while train/EV busy. */
  phase?: SolvePhase;
  /**
   * Optional EngineError-like / SolverIpcError input. When present, typed
   * class/phase/origin win over detail-text heuristics.
   */
  error?: unknown;
};

function resolvePollFault(args: StatusPollPolicyArgs): ClassifiedEngineFault {
  if (args.error !== undefined) {
    const fromError = classifyEngineFault(args.error);
    // Prefer an explicit detail string when the caller already composed one
    // (e.g. status detail + shell hint), but keep typed fields from error.
    if (args.detail.trim() && args.detail.trim() !== fromError.detail) {
      const fromDetail = classifyEngineFault(args.detail);
      return {
        ...fromError,
        detail: args.detail.trim(),
        // Typed class stays authoritative when present.
        faultClass: fromError.classFromTypedField
          ? fromError.faultClass
          : fromDetail.faultClass,
        congestion:
          fromError.congestion ||
          fromDetail.congestion ||
          isAdmissionSaturationDetail(args.detail),
        softTimeout:
          fromError.softTimeout ||
          fromDetail.softTimeout ||
          isSoftRpcTimeoutDetail(args.detail),
        sessionDead:
          fromError.sessionDead ||
          (!fromError.classFromTypedField &&
            !fromError.congestion &&
            !fromDetail.congestion &&
            isEngineSessionDead(args.detail)),
      };
    }
    return fromError;
  }
  return classifyEngineFault(args.detail);
}

/**
 * Single status-poll recovery decision (audit §3).
 * Congestion and preserve-phase soft timeouts never mark dead or terminate.
 */
export function decideStatusPollRecovery(
  args: StatusPollPolicyArgs,
): StatusPollRecoveryDecision {
  if (args.consecutiveFailures < 0) {
    throw new Error("contract: consecutiveFailures must be >= 0");
  }
  const threshold = args.threshold ?? STATUS_POLL_DEAD_AFTER_FAILURES;
  if (threshold < 1) {
    throw new Error("contract: status-poll dead threshold must be >= 1");
  }
  const fault = resolvePollFault(args);

  if (fault.sessionDead || isEngineSessionDead(fault.detail)) {
    return {
      markDead: true,
      terminate: true,
      reason: "hard_session_dead",
      fault: { ...fault, sessionDead: true },
    };
  }

  if (isCongestionFault(fault)) {
    return {
      markDead: false,
      terminate: false,
      reason: "congestion_backoff",
      fault: { ...fault, congestion: true },
    };
  }

  if (
    fault.softTimeout &&
    args.phase != null &&
    softStatusTimeoutPreservesSession(args.phase)
  ) {
    return {
      markDead: false,
      terminate: false,
      reason: "soft_timeout_preserve",
      fault,
    };
  }

  if (args.consecutiveFailures >= threshold) {
    return {
      markDead: true,
      terminate: true,
      reason: "hung_threshold",
      fault,
    };
  }

  return {
    markDead: false,
    terminate: false,
    reason: "below_threshold",
    fault,
  };
}

/**
 * Decide whether a status-poll failure should paint Reconnect / unreachable.
 * Transient decode/timeout blips must not flicker "Engine unreachable" over a
 * healthy sidecar (ZR-148). Congestion is backoff only (IPC audit §3).
 */
export function shouldMarkStatusPollDead(args: StatusPollPolicyArgs): boolean {
  return decideStatusPollRecovery(args).markDead;
}

/**
 * ZR-151 / IPC audit §3: after N soft status failures Study may kill the
 * sidecar (hung host) then Reconnect — but never for congestion, and never for
 * soft timeouts while Solving / Complete (unsaved solution still in child).
 * Hard pipe-death faults already imply a dead process.
 */
export function shouldTerminateHungSidecar(args: StatusPollPolicyArgs): boolean {
  return decideStatusPollRecovery(args).terminate;
}

/**
 * Ready probe / ensure against an existing child (IPC audit §3 row 4).
 * Do not tear down solely from timeout or admission text. When the error class
 * is missing, fail closed toward preserve + explicit restart semantics.
 */
export function decideReadyProbeOnExistingChild(
  error: unknown,
): ReadyProbeRecoveryDecision {
  const fault = classifyEngineFault(error);

  if (fault.faultClass === "connection_loss" || fault.sessionDead) {
    const processExit =
      /sidecar_exit|solver-engine exiting|session killed|process (exited|exit)/i.test(
        fault.detail,
      );
    return {
      teardown: true,
      explicitRestart: false,
      preserve: false,
      observation: processExit ? "process_exit" : "failed_connection",
      reason: processExit
        ? "observed process exit — teardown existing child"
        : "failed connection / pipe death — teardown existing child",
      fault,
    };
  }

  if (fault.congestion || fault.faultClass === "queue_saturation") {
    return {
      teardown: false,
      explicitRestart: true,
      preserve: true,
      observation: "congestion",
      reason:
        "admission/queue saturation on Ready probe — preserve child; offer explicit restart",
      fault,
    };
  }

  if (fault.softTimeout || fault.faultClass === "timeout") {
    return {
      teardown: false,
      explicitRestart: true,
      preserve: true,
      observation: "missed_observation",
      reason:
        "Ready probe timeout — missed observation, not proof of death; preserve child",
      fault,
    };
  }

  if (fault.faultClass === "engine_rejection") {
    return {
      teardown: false,
      explicitRestart: true,
      preserve: true,
      observation: "engine_rejection",
      reason:
        "engine rejected Ready probe — preserve child; offer explicit restart",
      fault,
    };
  }

  // Class missing or unknown: fail closed toward preserve + explicit restart.
  return {
    teardown: false,
    explicitRestart: true,
    preserve: true,
    observation: "unknown",
    reason: fault.classFromTypedField
      ? "non-fatal Ready probe fault — preserve child; offer explicit restart"
      : "Ready probe error class missing — fail closed: preserve child + explicit restart",
    fault,
  };
}

/**
 * A slow values/EV RPC timeout must not be classified as session-dead and must
 * not stop an in-flight solve (ZR-151 / #289).
 */
export function isSoftRpcTimeoutDetail(detail: string): boolean {
  const text = detail.toLowerCase();
  return (
    text.includes("timed out") ||
    text.includes("timeout") ||
    text.includes("recv timeout") ||
    text.includes("expired-before-write") ||
    text.includes("unknown-after-write")
  );
}

/**
 * Soft-recover a train RPC timeout only when the host shows live train activity.
 * A pre-existing `solution_id` alone is not evidence the new command ran
 * (IPC audit §4 / StudyStore wire-up).
 */
export function shouldSoftRecoverTrainTimeout(status: {
  running?: boolean;
  paused?: boolean;
  solution_id?: string | null;
}): boolean {
  return Boolean(status.running || status.paused);
}

/**
 * Ensure/Ready failed while the child may still be alive — never silent teardown.
 * Caller should offer Restart Engine (forceRestart) with unsaved-work consequence.
 */
export function explicitRestartRecoveryMessage(detail: string): string {
  const cleaned = detail.trim() || "connection unusable";
  return `Engine connection unusable: ${cleaned}. The solver process may still be alive with unsaved work. Use Restart Engine to tear it down and spawn fresh — unsaved progress in that child may be lost.`;
}

/** True when store message is a disconnected / ensure-fail recovery string. */
export function isRecoveryOrUnreachableMessage(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes("engine unreachable") ||
    text.includes("reconnecting") ||
    text.includes("engine setup failed") ||
    text.includes("use reconnect") ||
    text.includes("restart engine") ||
    text.includes("connection unusable")
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
