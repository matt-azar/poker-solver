/**
 * Per-session Study lifecycle: status poll scheduling, analysis tokens/queue,
 * and request invalidation keyed by solution / node / revision / metric.
 *
 * Keeps timers and cancellation out of the Zustand façade (`studyStore.ts`)
 * while callers continue to use store actions unchanged.
 */

import {
  AnalysisPageCache,
  AnalysisRequestQueue,
  type AnalysisPriority,
  type WorkerAnalysisKind,
} from "../domain/analysisCache";
import { EngineError } from "../engine/client";
import { SolverIpcError } from "../engine/transport";
import {
  type AnalysisIdentity,
  type AnalysisKind,
} from "../domain/setup";
import type { ActionValuesPayload, NodePayload, StatusPayload } from "../domain/types";

/** Host gen-supersession / mid-publish misses — safe to re-admit for the live token. */
const TRANSIENT_ANALYSIS_CODES = new Set(["superseded", "nothing_published"]);
/** Cap transient retries so a wedged host cannot spin forever. */
const TRANSIENT_ANALYSIS_RETRIES = 8;

const ANALYSIS_KINDS: AnalysisKind[] = ["values", "equity", "categories"];

let pollTimer: ReturnType<typeof setTimeout> | null = null;
/** True while AppShell (or solve/open) wants periodic status polls. */
let statusPollActive = false;
/** Coalesced in-flight status refresh; single-flight across poll + manual refresh. */
let statusInFlight: Promise<void> | null = null;
/** When true, another refresh was requested during the in-flight cycle. */
let statusRefreshQueued = false;
/** AbortController for the active status request (shutdown cancel vs timeout). */
let statusAbortController: AbortController | null = null;
let statusConsecutiveFailures = 0;
let nodeToken = 0;
let statusToken = 0;
let seenGeneration = -1;

/** Independent tokens so equity polling does not cancel sibling metrics. */
const analysisTokens: Record<AnalysisKind, number> = {
  values: 0,
  equity: 0,
  categories: 0,
};
const analysisPollTimers: Partial<Record<AnalysisKind, ReturnType<typeof setInterval>>> = {};
const analysisRequestIdentity: Partial<Record<AnalysisKind, AnalysisIdentity>> = {};
/** Survives navigation so Study does not recompute EV/equity on every click. */
const analysisPageCache = new AnalysisPageCache(64);
/** One ValueWorker-bound job at a time (equity/values cancel each other). */
const analysisRequestQueue = new AnalysisRequestQueue();
/** Bumped on navigate so in-flight prefetch polls abandon promptly. */
let analysisPrefetchEpoch = 0;

/** Test helper: reset status single-flight / backoff module state between cases. */
export function resetStatusPollingForTests() {
  statusPollActive = false;
  statusRefreshQueued = false;
  statusConsecutiveFailures = 0;
  statusInFlight = null;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  statusAbortController?.abort();
  statusAbortController = null;
  seenGeneration = -1;
  statusToken = 0;
}

/** Test helper: drop analysis cache/queue without resetting the whole store. */
export function resetAnalysisCacheForTests() {
  analysisPageCache.clear();
  analysisRequestQueue.cancelQueued();
  analysisPrefetchEpoch += 1;
}

export function isStatusPollActive(): boolean {
  return statusPollActive;
}

export function getStatusInFlight(): Promise<void> | null {
  return statusInFlight;
}

export function setStatusInFlight(promise: Promise<void> | null): void {
  statusInFlight = promise;
}

export function isStatusRefreshQueued(): boolean {
  return statusRefreshQueued;
}

export function setStatusRefreshQueued(value: boolean): void {
  statusRefreshQueued = value;
}

export function getStatusConsecutiveFailures(): number {
  return statusConsecutiveFailures;
}

export function setStatusConsecutiveFailures(value: number): void {
  statusConsecutiveFailures = value;
}

export function getSeenGeneration(): number {
  return seenGeneration;
}

export function setSeenGeneration(value: number): void {
  seenGeneration = value;
}

export function getStatusToken(): number {
  return statusToken;
}

export function bumpStatusToken(): number {
  statusToken += 1;
  return statusToken;
}

export function getNodeToken(): number {
  return nodeToken;
}

/** Invalidate in-flight node fetches so a delayed s1 payload cannot paint during s2. */
export function bumpNodeToken(): number {
  nodeToken += 1;
  return nodeToken;
}

export function getStatusAbortController(): AbortController | null {
  return statusAbortController;
}

export function setStatusAbortController(value: AbortController | null): void {
  statusAbortController = value;
}

export function getPollTimer(): ReturnType<typeof setTimeout> | null {
  return pollTimer;
}

export function setPollTimer(value: ReturnType<typeof setTimeout> | null): void {
  pollTimer = value;
}

export function getAnalysisPageCache(): AnalysisPageCache {
  return analysisPageCache;
}

export function getAnalysisRequestQueue(): AnalysisRequestQueue {
  return analysisRequestQueue;
}

export function getAnalysisPrefetchEpoch(): number {
  return analysisPrefetchEpoch;
}

export function bumpAnalysisPrefetchEpoch(): number {
  analysisPrefetchEpoch += 1;
  return analysisPrefetchEpoch;
}

function clearAnalysisPoll(kind: AnalysisKind) {
  const timer = analysisPollTimers[kind];
  if (timer) {
    clearInterval(timer);
    delete analysisPollTimers[kind];
  }
}

export function clearAllAnalysisPolls() {
  ANALYSIS_KINDS.forEach((kind) => {
    clearAnalysisPoll(kind);
  });
}

function bumpAnalysisToken(kind: AnalysisKind): number {
  analysisTokens[kind] += 1;
  clearAnalysisPoll(kind);
  delete analysisRequestIdentity[kind];
  return analysisTokens[kind];
}

export function invalidateAllAnalysisRequests() {
  ANALYSIS_KINDS.forEach((kind) => {
    bumpAnalysisToken(kind);
  });
}

export function invalidateLifecycleRequests() {
  bumpNodeToken();
  bumpStatusToken();
  invalidateAllAnalysisRequests();
}

export function beginAnalysisRequest(
  kind: AnalysisKind,
  solutionId: string,
  nodeId: string,
  revision: number,
): { token: number; identity: AnalysisIdentity } {
  const token = bumpAnalysisToken(kind);
  const identity: AnalysisIdentity = { solutionId, nodeId, revision, kind };
  analysisRequestIdentity[kind] = identity;
  return { token, identity };
}

export function analysisRequestIsCurrent(kind: AnalysisKind, token: number): boolean {
  return token === analysisTokens[kind];
}

/** Sleep helper for the sequential analysis poll loop. */
function sleepAnalysis(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Surface EngineError / SolverIpcError messages; never hide host error_code text. */
export function analysisErrorMessage(error: unknown): string {
  if (error instanceof EngineError || error instanceof SolverIpcError) {
    return error.message;
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "Analysis request failed";
}

/** True when the host rejection is expected under overlap / mid-publish. */
export function isTransientAnalysisError(error: unknown): boolean {
  if (error instanceof SolverIpcError) {
    const code = (error.errorCode ?? "").trim().toLowerCase();
    if (code && TRANSIENT_ANALYSIS_CODES.has(code)) {
      return true;
    }
  }
  const message = analysisErrorMessage(error);
  return /superseded|nothing_published/i.test(message);
}

/**
 * Poll async analysis endpoints that may return `{ pending: true }` / HTTP 202.
 * The returned promise represents the full lifecycle through ready/failed/abort —
 * the request queue must not release its slot on the first 202.
 * Transient host codes (`superseded`, `nothing_published`) re-admit while the
 * token is still current instead of settling a blank EV/equity failure.
 */
export async function pollAnalysis<T extends { pending?: boolean }>(
  kind: AnalysisKind,
  token: number,
  fetchOnce: () => Promise<T>,
  onReady: (body: T) => void,
  onError: (message: string) => void,
): Promise<void> {
  clearAnalysisPoll(kind);
  let transientFailures = 0;
  // At most one outstanding request: await each tick before the next.
  while (analysisRequestIsCurrent(kind, token)) {
    try {
      const body = await fetchOnce();
      if (!analysisRequestIsCurrent(kind, token)) {
        return;
      }
      if (body && body.pending) {
        await sleepAnalysis(250);
        continue;
      }
      onReady(body);
      return;
    } catch (error) {
      if (!analysisRequestIsCurrent(kind, token)) {
        return;
      }
      if (
        isTransientAnalysisError(error) &&
        transientFailures < TRANSIENT_ANALYSIS_RETRIES
      ) {
        transientFailures += 1;
        await sleepAnalysis(50 * transientFailures);
        continue;
      }
      onError(analysisErrorMessage(error));
      return;
    }
  }
}

export function analysisRevision(
  node: NodePayload | null | undefined,
  status: StatusPayload | null | undefined,
): number {
  // Prefer the published profile revision so continue / strategy edits invalidate
  // cached EV/equity under the same solution id without waiting on generation.
  // Host status emits `policy_revision`; equity replies also mirror it as
  // `analysis_revision`. Falling back to status_generation alone misses publish
  // bumps that keep the same solution id (stale strategy / blank EV cache).
  if (typeof status?.analysis_revision === "number") {
    return status.analysis_revision;
  }
  if (typeof status?.policy_revision === "number") {
    return status.policy_revision;
  }
  const nodeAnalysis = (node as { analysis_revision?: number } | null | undefined)
    ?.analysis_revision;
  if (typeof nodeAnalysis === "number") {
    return nodeAnalysis;
  }
  if (typeof node?.policy_revision === "number") {
    return node.policy_revision;
  }
  if (typeof node?.status_generation === "number") {
    return node.status_generation;
  }
  if (typeof status?.status_generation === "number") {
    return status.status_generation;
  }
  return 0;
}

/** Work-limit failures stay settled for the current inputs; no auto-resubmit. */
export function analysisErrorIsPermanent(message: string | undefined | null): boolean {
  return Boolean(message && /work limit/i.test(message));
}

/** Read host publish epoch from status or a painted node (0 when unknown). */
export function policyRevisionOf(
  source:
    | { policy_revision?: number; analysis_revision?: number }
    | null
    | undefined,
): number {
  if (!source) {
    return 0;
  }
  if (typeof source.policy_revision === "number") {
    return source.policy_revision;
  }
  if (typeof source.analysis_revision === "number") {
    return source.analysis_revision;
  }
  return 0;
}

export function cachedAnalysisForNode(
  solutionId: string,
  nodeId: string,
  revision: number,
) {
  return {
    nodeValues:
      analysisPageCache.get<ActionValuesPayload>({
        solutionId,
        nodeId,
        revision,
        kind: "values",
      }) ?? null,
    equity:
      analysisPageCache.get({
        solutionId,
        nodeId,
        revision,
        kind: "equity",
      }) ?? null,
    categories:
      analysisPageCache.get({
        solutionId,
        nodeId,
        revision,
        kind: "categories",
      }) ?? null,
  };
}

export function dropAnalysisCaches() {
  analysisPageCache.clear();
  analysisRequestQueue.cancelQueued();
}

export function enqueueWorkerAnalysis(args: {
  kind: WorkerAnalysisKind;
  solutionId: string;
  nodeId: string;
  revision: number;
  priority: AnalysisPriority;
  run: () => Promise<void>;
}): void {
  analysisRequestQueue.enqueue({
    kind: args.kind,
    solutionId: args.solutionId,
    nodeId: args.nodeId,
    revision: args.revision,
    priority: args.priority,
    run: args.run,
  });
}

/**
 * Arm periodic status polling. `kickRefresh` should invoke the store's
 * `refresh()` so façade callers stay unchanged.
 */
export function startStatusPolling(kickRefresh: () => void): void {
  if (statusPollActive) {
    return;
  }
  statusPollActive = true;
  kickRefresh();
}

/** Stop status polling and abort any in-flight status request (shutdown cancel). */
export function stopStatusPolling(): void {
  statusPollActive = false;
  statusRefreshQueued = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  statusAbortController?.abort();
  statusAbortController = null;
  clearAllAnalysisPolls();
}

/** Schedule the next status poll tick when polling is still active. */
export function scheduleStatusPoll(delayMs: number, kickRefresh: () => void): void {
  if (!statusPollActive) {
    return;
  }
  if (pollTimer) {
    clearTimeout(pollTimer);
  }
  pollTimer = setTimeout(() => {
    pollTimer = null;
    kickRefresh();
  }, delayMs);
}
