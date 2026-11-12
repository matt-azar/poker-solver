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
import {
  type AnalysisIdentity,
  type AnalysisKind,
} from "../domain/setup";
import type { ActionValuesPayload, NodePayload, StatusPayload } from "../domain/types";

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

/**
 * Poll async analysis endpoints that may return `{ pending: true }` / HTTP 202.
 * The returned promise represents the full lifecycle through ready/failed/abort —
 * the request queue must not release its slot on the first 202.
 */
export async function pollAnalysis<T extends { pending?: boolean }>(
  kind: AnalysisKind,
  token: number,
  fetchOnce: () => Promise<T>,
  onReady: (body: T) => void,
  onError: (message: string) => void,
): Promise<void> {
  clearAnalysisPoll(kind);
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
      onError(error instanceof EngineError ? error.message : "Analysis request failed");
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
  if (typeof status?.analysis_revision === "number") {
    return status.analysis_revision;
  }
  const nodeRevision = (node as { analysis_revision?: number } | null | undefined)
    ?.analysis_revision;
  if (typeof nodeRevision === "number") {
    return nodeRevision;
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
