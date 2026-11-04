/**
 * Request / mutation identity scopes and status-poll scheduling helpers.
 *
 * After every await, callers re-check the captured scope against live study
 * state before mutating UI. Status polling is single-flight: one request at a
 * time, next poll scheduled after completion, with timeout + failure backoff.
 */

import { actionsSignature } from "./setup/identity";

/** Default gap between successful status polls (ms). */
export const STATUS_POLL_INTERVAL_MS = 250;
/** Abort an in-flight status request after this many ms. */
export const STATUS_POLL_TIMEOUT_MS = 4_000;
/** First retry delay after a failed status poll (ms). */
export const STATUS_POLL_BACKOFF_INITIAL_MS = 500;
/** Cap on exponential backoff after consecutive failures (ms). */
export const STATUS_POLL_BACKOFF_MAX_MS = 8_000;

/** Solution + node (+ optional revision / actions) for one mutation or fetch. */
export interface StudyMutationScope {
  solutionId: string;
  nodeId: string;
  /** status_generation / solution revision when known. */
  revision?: number;
  /** Action-label signature when the draft is action-bound. */
  actionsSignature?: string;
}

export interface CompareRequestScope {
  baselineId: string;
  scenarioId: string;
  nodeId: string;
}

export type StatusPollOutcome =
  | { kind: "success" }
  | { kind: "failure" }
  | { kind: "shutdown_cancel" };

export function captureStudyMutationScope(args: {
  solutionId: string | null | undefined;
  nodeId: string | null | undefined;
  revision?: number | null;
  actions?: string[] | null;
}): StudyMutationScope | null {
  if (!args.solutionId || !args.nodeId) {
    return null;
  }
  const scope: StudyMutationScope = {
    solutionId: args.solutionId,
    nodeId: args.nodeId,
  };
  if (typeof args.revision === "number") {
    scope.revision = args.revision;
  }
  if (args.actions) {
    scope.actionsSignature = actionsSignature(args.actions);
  }
  return scope;
}

export function studyMutationScopesEqual(
  a: StudyMutationScope | null | undefined,
  b: StudyMutationScope | null | undefined,
): boolean {
  if (!a || !b) {
    return false;
  }
  if (a.solutionId !== b.solutionId || a.nodeId !== b.nodeId) {
    return false;
  }
  if (
    a.revision !== undefined &&
    b.revision !== undefined &&
    a.revision !== b.revision
  ) {
    return false;
  }
  if (
    a.actionsSignature !== undefined &&
    b.actionsSignature !== undefined &&
    a.actionsSignature !== b.actionsSignature
  ) {
    return false;
  }
  return true;
}

/**
 * True when live study identity still matches the scope captured before an await.
 * Missing live solution/node fails closed (do not mutate).
 */
export function studyMutationScopeIsCurrent(
  captured: StudyMutationScope | null | undefined,
  live: {
    solutionId: string | null | undefined;
    nodeId: string | null | undefined;
    revision?: number | null;
    actions?: string[] | null;
  },
): boolean {
  const liveScope = captureStudyMutationScope(live);
  return studyMutationScopesEqual(captured, liveScope);
}

export function captureCompareRequestScope(args: {
  baselineId: string | null | undefined;
  scenarioId: string | null | undefined;
  nodeId: string | null | undefined;
}): CompareRequestScope | null {
  if (!args.baselineId || !args.scenarioId || !args.nodeId) {
    return null;
  }
  return {
    baselineId: args.baselineId,
    scenarioId: args.scenarioId,
    nodeId: args.nodeId,
  };
}

export function compareRequestScopesEqual(
  a: CompareRequestScope | null | undefined,
  b: CompareRequestScope | null | undefined,
): boolean {
  if (!a || !b) {
    return false;
  }
  return (
    a.baselineId === b.baselineId &&
    a.scenarioId === b.scenarioId &&
    a.nodeId === b.nodeId
  );
}

/**
 * After compare returns, require both payload validity args and the live
 * baseline/scenario/node to still match the request that was issued.
 */
export function compareRequestIsCurrent(
  captured: CompareRequestScope | null | undefined,
  live: {
    baselineId: string | null | undefined;
    scenarioId: string | null | undefined;
    nodeId: string | null | undefined;
  },
): boolean {
  return compareRequestScopesEqual(captured, captureCompareRequestScope(live));
}

/** True for AbortError from fetch / AbortController (incl. shutdown cancel). */
export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  return name === "AbortError";
}

/**
 * Classify a status-poll abort: shutdown cancel vs timeout/other failure.
 * Timeout aborts are always failures. A non-timeout abort after stopPolling()
 * (`pollActive === false`) is shutdown cancel and must not paint "unreachable".
 */
export function classifyStatusPollError(
  error: unknown,
  options: { pollActive: boolean; timedOut?: boolean },
): StatusPollOutcome {
  if (isAbortError(error)) {
    if (options.timedOut) {
      return { kind: "failure" };
    }
    if (!options.pollActive) {
      return { kind: "shutdown_cancel" };
    }
  }
  return { kind: "failure" };
}

/**
 * Delay until the next status poll. Success uses the base interval; failures
 * use exponential backoff capped at backoffMaxMs.
 */
export function nextStatusPollDelay(args: {
  outcome: StatusPollOutcome["kind"];
  consecutiveFailures: number;
  baseIntervalMs?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
}): number {
  const base = args.baseIntervalMs ?? STATUS_POLL_INTERVAL_MS;
  if (args.outcome === "success" || args.outcome === "shutdown_cancel") {
    return base;
  }
  const initial = args.backoffInitialMs ?? STATUS_POLL_BACKOFF_INITIAL_MS;
  const max = args.backoffMaxMs ?? STATUS_POLL_BACKOFF_MAX_MS;
  const failures = Math.max(1, args.consecutiveFailures);
  const delay = initial * 2 ** (failures - 1);
  return Math.min(max, delay);
}

/**
 * Combine an optional external signal with a timeout into one AbortSignal.
 * Aborting either aborts the returned controller. Caller should clear the
 * timeout via the returned dispose() (also safe after abort).
 */
export function createTimeoutSignal(
  timeoutMs: number,
  external?: AbortSignal | null,
): {
  signal: AbortSignal;
  controller: AbortController;
  timedOut: () => boolean;
  dispose: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };
  if (external) {
    if (external.aborted) {
      controller.abort();
    } else {
      external.addEventListener("abort", onExternalAbort, { once: true });
    }
  }
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          if (!controller.signal.aborted) {
            timedOut = true;
            controller.abort();
          }
        }, timeoutMs)
      : null;
  const dispose = () => {
    if (timer != null) {
      clearTimeout(timer);
    }
    if (external) {
      external.removeEventListener("abort", onExternalAbort);
    }
  };
  return {
    signal: controller.signal,
    controller,
    timedOut: () => timedOut,
    dispose,
  };
}
