import { invoke } from "@tauri-apps/api/core";
import type {
  ActionValuesPayload,
  NodePayload,
  SolveJobRequest,
  StatusPayload,
  TreePreviewPayload,
} from "../domain/types";
import { presentUserText } from "../domain/userText";
import {
  applyOpenJobLocalReset,
  beginPendingJob,
  buildTrainRequestBody,
  commitJobOnAdmission,
  createCompositeSolveIntent,
  defaultStopJobId,
  emptyJobIdBook,
  interpretCancelReply,
  isTrainAdmissionSuccess,
  latchSolveCancel,
  maySendTrain,
  noteBuildComplete,
  noteSolveTerminal,
  noteTrainAdmitted,
  stopAppliesDuringBuild,
  type CancelAck,
  type CompositeSolveIntent,
  type JobIdBook,
} from "../domain/jobIntent";
import { isTauriRuntime } from "../platform";
import { decodeErrorPayload } from "./contracts/error";
import { decodeStatusPayload } from "./contracts/status";
import { formatSolveJobStreetConfig, parseStreetConfigTextToSolutionConfig } from "./streetConfigText";
import { isAbortError, raceWithAbort } from "../domain/requestScope";
import {
  ipcBeginConfig,
  ipcCancel,
  ipcCancelEquityJob,
  ipcCategories,
  ipcCompare,
  ipcDeleteLock,
  ipcDeleteStrategyEdit,
  ipcEquity,
  ipcGetConfig,
  ipcGetEquityJob,
  ipcLineCardReport,
  ipcListLocks,
  ipcListStrategyEdits,
  ipcNode,
  ipcOpen,
  ipcPause,
  ipcPutLock,
  ipcPutStrategyEdit,
  ipcResolveLocked,
  ipcSave,
  ipcSolve,
  ipcStartEquityJob,
  ipcStatus,
  ipcTreePreview,
  ipcValueBluffsPostCall,
  ipcValues,
  mintStudyJobId,
  isIpcTransport,
} from "./transport";

function streetConfigTextFromPreviewJob(job: SolveJobRequest | { text: string }): string {
  if ("text" in job && typeof (job as { text?: unknown }).text === "string") {
    return (job as { text: string }).text;
  }
  return formatSolveJobStreetConfig(job as SolveJobRequest);
}

/** Normalize host solution identity (`s12` or bare 12) without relabeling. */
function hostedSolutionId(
  raw: unknown,
  fallback?: string | null,
): string | null {
  if (typeof raw === "string" && raw.trim()) {
    const text = raw.trim();
    if (/^s?\d+$/i.test(text)) {
      return text.toLowerCase().startsWith("s") ? text.toLowerCase() : `s${text}`;
    }
    return text;
  }
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return `s${Math.trunc(raw)}`;
  }
  return fallback ?? null;
}

function defaultEngineBaseUrl(): string {
  const fromEnv = import.meta.env.VITE_ENGINE_URL;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv;
  }
  // Packaged Study uses solver-engine IPC — never invent an HTTP base URL.
  // Vitest may still set VITE_ENGINE_URL for fixture-only request() tests.
  return "";
}


export class EngineError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(presentUserText(message));
    this.name = "EngineError";
    this.status = status;
    this.body = body;
  }
}

async function libraryInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return (await invoke(cmd, args ?? {})) as T;
  } catch (err) {
    throw new EngineError(err instanceof Error ? err.message : String(err), 0, null);
  }
}

export interface EngineClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

type TrainAdmissionReply = {
  accepted?: boolean;
  running?: boolean;
  busy?: boolean;
  error_code?: string | null;
  solution_id?: number | string;
  baseline_solution_id?: number | string;
  policy_revision?: number;
  trained?: number;
  terminal_reason?: string;
  threads?: number;
};

export class EngineClient {
  private readonly constructorBaseUrl: string | undefined;
  private runtimeBaseUrl: string | undefined;
  private readonly fetchImpl: typeof fetch;
  /** Authoritative vs pending Study train ids — promote only on admission. */
  private jobBook: JobIdBook = emptyJobIdBook();
  /** Composite Build→Train cancel latch for the in-flight Solve. */
  private solveIntent: CompositeSolveIntent | null = null;
  /** Last cancel interpretation for Study Stop presentation. */
  private lastCancelAck: CancelAck | null = null;

  constructor(options: EngineClientOptions = {}) {
    this.constructorBaseUrl =
      options.baseUrl !== undefined ? options.baseUrl.replace(/\/$/, "") : undefined;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  }

  /**
   * Default Stop/Pause target: admitted active id, else pending Build→Train id.
   * Pending alone is never preferred over an admitted active job.
   */
  lastStudyJobId(): string | null {
    return defaultStopJobId(this.jobBook) ?? this.jobBook.pendingJobId;
  }

  /** Drop stale Study job book after sidecar respawn / session recovery (ZR-123). */
  clearLastStudyJobId(): void {
    this.jobBook = emptyJobIdBook();
    this.solveIntent = null;
    this.lastCancelAck = null;
  }

  /** Last Stop/cancel acknowledgement (Build-handoff noop vs cancelled). */
  lastStopAck(): CancelAck | null {
    return this.lastCancelAck;
  }

  /**
   * Soft-recover after a train RPC timeout: if the host is still training,
   * promote pending → active so default Stop targets the live job.
   */
  adoptPendingJobIfRunning(status: {
    running?: boolean;
    job_id?: string | null;
  }): void {
    if (!status.running) {
      return;
    }
    if (this.jobBook.pendingJobId) {
      this.jobBook = {
        activeJobId: this.jobBook.pendingJobId,
        pendingJobId: null,
      };
      if (this.solveIntent && !this.solveIntent.cancelLatched) {
        this.solveIntent = noteTrainAdmitted(this.solveIntent);
      }
      return;
    }
    const hostJob =
      typeof status.job_id === "string" && status.job_id.trim()
        ? status.job_id.trim()
        : null;
    if (hostJob && !this.jobBook.activeJobId) {
      this.jobBook = { activeJobId: hostJob, pendingJobId: null };
    }
  }

  private cancelTargetJobId(explicit?: string): string | null {
    if (explicit) {
      return explicit;
    }
    if (this.solveIntent && stopAppliesDuringBuild(this.solveIntent)) {
      return this.solveIntent.jobId;
    }
    return defaultStopJobId(this.jobBook) ?? this.jobBook.pendingJobId;
  }

  private commitTrainAdmission(
    jobId: string,
    reply: TrainAdmissionReply,
  ): boolean {
    this.jobBook = commitJobOnAdmission(this.jobBook, reply);
    const admitted = isTrainAdmissionSuccess(reply);
    if (this.solveIntent?.jobId === jobId) {
      this.solveIntent = admitted
        ? noteTrainAdmitted(this.solveIntent)
        : noteSolveTerminal(this.solveIntent);
    }
    return admitted;
  }

  /** Packaged Study sets this after `ensureEngine()` resolves the owned sidecar. */
  setBaseUrl(baseUrl: string | null | undefined): void {
    if (baseUrl == null || baseUrl.trim() === "") {
      this.runtimeBaseUrl = undefined;
      return;
    }
    this.runtimeBaseUrl = baseUrl.replace(/\/$/, "");
  }

  /** Resolved base URL (runtime override, constructor, or default). */
  currentBaseUrl(): string {
    return this.baseUrl();
  }

  private baseUrl(): string {
    if (this.runtimeBaseUrl !== undefined) {
      return this.runtimeBaseUrl;
    }
    if (this.constructorBaseUrl !== undefined) {
      return this.constructorBaseUrl;
    }
    return defaultEngineBaseUrl().replace(/\/$/, "");
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    init: RequestInit = {},
  ): Promise<{ response: Response; data: unknown }> {
    // Packaged Zig path must never fall through to HTTP fetch.
    if (isIpcTransport()) {
      throw new EngineError(
        `HTTP ${method} ${path} is unavailable over solver-engine IPC`,
        501,
        null,
      );
    }
    // Empty base URL + fetch("") paints "Engine unreachable: Failed to fetch"
    // (same class as #288). Refuse before dialing — HTTP is fixture-only.
    const base = this.baseUrl();
    if (!base) {
      throw new EngineError(
        "No engine URL — Study requires the Tauri shell + solver-engine IPC",
        0,
        null,
      );
    }
    if (isTauriRuntime()) {
      throw new EngineError(
        `HTTP ${method} ${path} is unavailable in the packaged Study shell`,
        501,
        null,
      );
    }
    const headers = new Headers(init.headers);
    if (body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    const response = await this.fetchImpl(`${base}${path}`, {
      ...init,
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await readBody(response);
    return { response, data };
  }

  private ensureOk(response: Response, data: unknown, allow202 = false): void {
    if (response.ok || (allow202 && response.status === 202)) {
      return;
    }
    const message =
      decodeErrorPayload(data) ?? (response.statusText || `HTTP ${response.status}`);
    throw new EngineError(message, response.status, data);
  }

  async status(signal?: AbortSignal): Promise<StatusPayload> {
    if (isIpcTransport()) {
      // Honor poll timeout / shutdown abort (ZR-148). Tauri invoke keeps
      // running until the Rust status budget (ZR-175: 8s, not 240s); Study
      // unblocks earlier via raceWithAbort and drops the late frame via token.
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      let data: unknown;
      try {
        data = await raceWithAbort(ipcStatus(), signal);
      } catch (err) {
        if (
          err &&
          typeof err === "object" &&
          (err as { name?: unknown }).name === "AbortError"
        ) {
          throw err;
        }
        throw new EngineError(err instanceof Error ? err.message : String(err), 0, null);
      }
      try {
        return decodeStatusPayload(data);
      } catch (err) {
        throw new EngineError(err instanceof Error ? err.message : String(err), 0, data);
      }
    }
    // Packaged Study after session-dead clears IPC (ZR-175). Do not fall through
    // to HTTP "No engine URL" — that overwrote useful last-fault detail.
    if (isTauriRuntime()) {
      throw new EngineError(
        "solver-engine IPC not connected — use Reconnect",
        0,
        null,
      );
    }
    const { response, data } = await this.request("GET", "/api/status", undefined, { signal });
    this.ensureOk(response, data);
    try {
      return decodeStatusPayload(data);
    } catch (err) {
      throw new EngineError(
        err instanceof Error ? err.message : String(err),
        response.status,
        data,
      );
    }
  }

  async solve(job: SolveJobRequest, signal?: AbortSignal): Promise<unknown> {
    if (isIpcTransport()) {
      if (signal?.aborted) {
        throw new EngineError("aborted", 0, null);
      }
      const configText = formatSolveJobStreetConfig(job);
      const trainFields = buildTrainRequestBody("solve", {
        iterations: job.iterations,
        samples: job.samples,
        accuracy: job.accuracy,
        time_limit: job.time_limit,
      });
      const iterations = trainFields.iterations as number;
      const jobId = mintStudyJobId();
      this.jobBook = beginPendingJob(this.jobBook, jobId);
      this.solveIntent = createCompositeSolveIntent(jobId);
      this.lastCancelAck = null;
      await ipcBeginConfig(configText, jobId);
      let intent = this.solveIntent;
      if (intent?.jobId === jobId) {
        intent = noteBuildComplete(intent);
        this.solveIntent = intent;
      }
      if (signal?.aborted || !intent || !maySendTrain(intent)) {
        this.jobBook = commitJobOnAdmission(this.jobBook, {
          accepted: false,
          error_code: "cancelled",
        });
        if (this.solveIntent?.jobId === jobId) {
          this.solveIntent = noteSolveTerminal(this.solveIntent);
        }
        throw new EngineError(
          signal?.aborted ? "aborted" : "cancelled before train",
          0,
          null,
        );
      }
      const body = (await ipcSolve({
        iterations,
        accuracy:
          typeof trainFields.accuracy === "number" ? trainFields.accuracy : undefined,
        samples:
          typeof trainFields.samples === "number" ? trainFields.samples : undefined,
        time_limit:
          typeof trainFields.time_limit === "number"
            ? trainFields.time_limit
            : undefined,
        jobId,
      })) as TrainAdmissionReply;
      // Re-check latch after a Stop that raced the train write.
      intent = this.solveIntent;
      if (intent?.jobId === jobId && intent.cancelLatched) {
        this.jobBook = commitJobOnAdmission(this.jobBook, {
          accepted: false,
          error_code: "cancelled",
        });
        this.solveIntent = noteSolveTerminal(intent);
        throw new EngineError("cancelled before train", 0, null);
      }
      // Host short-admits train (ZR-90/ZR-106); Study polls status for completion.
      const admitted = this.commitTrainAdmission(jobId, body);
      return {
        running: admitted ? true : false,
        job_id: admitted ? jobId : defaultStopJobId(this.jobBook) ?? jobId,
        solution_id: hostedSolutionId(body.solution_id),
        policy_revision: body.policy_revision ?? 0,
        trained: admitted ? 0 : (body.trained ?? iterations),
        terminal_reason: admitted
          ? "admitted"
          : (body.terminal_reason ?? "completed"),
        threads: body.threads,
        transport: "ipc",
      };
    }
    const { response, data } = await this.request("POST", "/api/solve", job, { signal });
    this.ensureOk(response, data, true);
    return data;
  }

  async pause(jobId?: string): Promise<unknown> {
    if (isIpcTransport()) {
      const id = this.cancelTargetJobId(jobId);
      return ipcPause(id);
    }
    const { response, data } = await this.request(
      "POST",
      "/api/pause",
      jobId ? { job_id: jobId } : {},
    );
    this.ensureOk(response, data);
    return data;
  }

  /**
   * Stop a train/analysis job.
   * On IPC this maps to host `cancel` (cooperative stop at iteration boundary).
   * Default target is the admitted active id; during Build→Train the pending
   * composite job id is latched + cancelled so train is not admitted.
   */
  async stop(jobId?: string): Promise<unknown> {
    if (isIpcTransport()) {
      if (this.solveIntent) {
        this.solveIntent = latchSolveCancel(this.solveIntent);
      }
      const id = this.cancelTargetJobId(jobId);
      if (!id) {
        throw new EngineError("no active study job to cancel", 400, null);
      }
      const reply = (await ipcCancel(id)) as {
        cancelled?: boolean;
        reason?: string | null;
      };
      this.lastCancelAck = interpretCancelReply(reply, this.solveIntent);
      if (this.solveIntent?.cancelLatched) {
        this.solveIntent = noteSolveTerminal(this.solveIntent);
      }
      return { ...reply, cancel_ack: this.lastCancelAck };
    }
    const { response, data } = await this.request(
      "POST",
      "/api/stop",
      jobId ? { job_id: jobId } : {},
    );
    this.ensureOk(response, data);
    return data;
  }

  async continueSolve(
    solutionId: string,
    body: {
      iterations: number;
      time_limit?: number;
      samples?: number;
      accuracy?: number;
    },
  ): Promise<unknown> {
    if (isIpcTransport()) {
      // Host has no dedicated `continue` op: resume training on the open
      // session via `solve` (begin_config would wipe the trainer / has_training).
      // Mint a fresh pending job id; promote only after admission.
      void solutionId;
      const trainFields = buildTrainRequestBody("continue", {
        iterations: body.iterations,
        samples: body.samples,
        accuracy: body.accuracy,
        time_limit: body.time_limit,
      });
      const iterations = trainFields.iterations as number;
      const jobId = mintStudyJobId();
      this.jobBook = beginPendingJob(this.jobBook, jobId);
      this.solveIntent = null;
      this.lastCancelAck = null;
      const reply = (await ipcSolve({
        iterations,
        samples:
          typeof trainFields.samples === "number" ? trainFields.samples : undefined,
        accuracy:
          typeof trainFields.accuracy === "number" ? trainFields.accuracy : undefined,
        time_limit:
          typeof trainFields.time_limit === "number"
            ? trainFields.time_limit
            : undefined,
        jobId,
        solutionId,
      })) as TrainAdmissionReply;
      const admitted = this.commitTrainAdmission(jobId, reply);
      return {
        running: admitted ? true : false,
        job_id: admitted ? jobId : defaultStopJobId(this.jobBook) ?? jobId,
        solution_id: hostedSolutionId(reply.solution_id, solutionId),
        policy_revision: reply.policy_revision ?? 0,
        trained: admitted ? 0 : (reply.trained ?? iterations),
        terminal_reason: admitted
          ? "admitted"
          : (reply.terminal_reason ?? "completed"),
        threads: reply.threads,
        transport: "ipc",
      };
    }
    const { response, data } = await this.request(
      "POST",
      `/api/solutions/${solutionId}/continue`,
      body,
    );
    this.ensureOk(response, data, true);
    return data;
  }

  async resolveLocked(
    solutionId: string,
    body: {
      iterations: number;
      warm_start?: number;
      accuracy?: number;
      samples?: number;
      time_limit?: number;
    },
  ): Promise<unknown> {
    if (isIpcTransport()) {
      // Host resolve_locked: baseline stamp + optional reset + train under locks.
      void solutionId;
      const trainFields = buildTrainRequestBody("resolve_locked", {
        iterations: body.iterations,
        samples: body.samples,
        accuracy: body.accuracy,
        time_limit: body.time_limit,
        warm_start: body.warm_start,
      });
      const iterations = trainFields.iterations as number;
      const jobId = mintStudyJobId();
      this.jobBook = beginPendingJob(this.jobBook, jobId);
      this.solveIntent = null;
      this.lastCancelAck = null;
      const reply = (await ipcResolveLocked({
        iterations,
        warm_start: body.warm_start ? 1 : 0,
        accuracy:
          typeof trainFields.accuracy === "number" ? trainFields.accuracy : undefined,
        samples:
          typeof trainFields.samples === "number" ? trainFields.samples : undefined,
        time_limit:
          typeof trainFields.time_limit === "number"
            ? trainFields.time_limit
            : undefined,
        jobId,
        solutionId,
      })) as TrainAdmissionReply;
      const admitted = this.commitTrainAdmission(jobId, reply);
      return {
        running: admitted ? true : false,
        job_id: admitted ? jobId : defaultStopJobId(this.jobBook) ?? jobId,
        solution_id: hostedSolutionId(reply.solution_id, solutionId),
        baseline_solution_id: hostedSolutionId(reply.baseline_solution_id),
        policy_revision: reply.policy_revision ?? 0,
        trained: admitted ? 0 : (reply.trained ?? iterations),
        terminal_reason: admitted
          ? "admitted"
          : (reply.terminal_reason ?? "completed"),
        threads: reply.threads,
        transport: "ipc",
        warm_start: body.warm_start ? "continue" : "reset",
      };
    }
    const { response, data } = await this.request(
      "POST",
      `/api/solutions/${solutionId}/resolve-locked`,
      body,
    );
    this.ensureOk(response, data, true);
    return data;
  }

  async getNode(solutionId: string, nodeId: string, signal?: AbortSignal): Promise<NodePayload> {
    if (isIpcTransport()) {
      if (signal?.aborted) {
        throw new EngineError("aborted", 0, null);
      }
      const data = (await ipcNode(nodeId, solutionId)) as Record<string, unknown>;
      // Preserve host identity — never relabel a newer solution as the caller id.
      const served = hostedSolutionId(data.solution_id, solutionId);
      return {
        ...data,
        ...(served ? { solution_id: served } : {}),
        node_id: typeof data.node_id === "string" ? data.node_id : nodeId,
      } as NodePayload;
    }
    const { response, data } = await this.request(
      "GET",
      `/api/solutions/${solutionId}/nodes/${encodeURIComponent(nodeId)}`,
      undefined,
      { signal },
    );
    this.ensureOk(response, data, true);
    return data as NodePayload;
  }

  async getValues(
    solutionId: string,
    nodeId: string,
    signal?: AbortSignal,
  ): Promise<ActionValuesPayload> {
    if (isIpcTransport()) {
      if (signal?.aborted) {
        throw new EngineError("aborted", 0, null);
      }
      let data: Record<string, unknown>;
      try {
        data = (await ipcValues(nodeId, solutionId, signal)) as Record<string, unknown>;
      } catch (err) {
        if (signal?.aborted || isAbortError(err)) {
          throw new EngineError("aborted", 0, null);
        }
        throw err;
      }
      const served = hostedSolutionId(data.solution_id, solutionId);
      return {
        ...data,
        ...(served ? { solution_id: served } : {}),
        node_id: typeof data.node_id === "string" ? data.node_id : nodeId,
      } as ActionValuesPayload;
    }
    const { response, data } = await this.request(
      "GET",
      `/api/solutions/${solutionId}/nodes/${encodeURIComponent(nodeId)}/values`,
      undefined,
      { signal },
    );
    this.ensureOk(response, data, true);
    return data as ActionValuesPayload;
  }

  async getEquity(solutionId: string, nodeId?: string, signal?: AbortSignal): Promise<unknown> {
    if (isIpcTransport()) {
      if (signal?.aborted) {
        throw new EngineError("aborted", 0, null);
      }
      let data: Record<string, unknown>;
      try {
        data = (await ipcEquity(
          nodeId
            ? { nodeId, solutionId, signal }
            : { nodeIndex: 0, nodeId: "p0.t-1.r-1", solutionId, signal },
        )) as Record<string, unknown>;
      } catch (err) {
        if (signal?.aborted || isAbortError(err)) {
          throw new EngineError("aborted", 0, null);
        }
        throw err;
      }
      const served = hostedSolutionId(data.solution_id, solutionId);
      // Host packs equity generation into `status_generation` with a different
      // formula than status-path sequence — expose an explicit equity field and
      // do not feed this into Study status ordering (getSeenGeneration).
      const equityGeneration =
        typeof data.status_generation === "number" &&
        Number.isFinite(data.status_generation)
          ? data.status_generation
          : undefined;
      return {
        ...data,
        ...(served ? { solution_id: served } : {}),
        ...(equityGeneration !== undefined
          ? { equity_generation: equityGeneration }
          : {}),
        node_id:
          typeof data.node_id === "string"
            ? data.node_id
            : nodeId ?? "p0.t-1.r-1",
        pending: false,
        equity_scope: "node_reach",
      };
    }
    const path = nodeId
      ? `/api/solutions/${solutionId}/nodes/${encodeURIComponent(nodeId)}/equity`
      : `/api/solutions/${solutionId}/equity`;
    const { response, data } = await this.request("GET", path, undefined, { signal });
    this.ensureOk(response, data, true);
    return data;
  }

  /** Start Study metrics for a node (idempotent enqueue). */
  async startNodeAnalysis(
    solutionId: string,
    nodeId: string,
    metrics: Array<"values" | "equity"> = ["values", "equity"],
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (isIpcTransport()) {
      if (signal?.aborted) {
        throw new EngineError("aborted", 0, null);
      }
      // Thin sync warm: Study still polls getValues/getEquity. No 202 job handle yet.
      const wanted = metrics.filter((m) => m === "values" || m === "equity");
      return {
        pending: false,
        ok: true,
        solution_id: solutionId,
        node_id: nodeId,
        metrics: wanted,
        transport: "ipc",
      };
    }
    const { response, data } = await this.request(
      "POST",
      `/api/solutions/${solutionId}/nodes/${encodeURIComponent(nodeId)}/analysis`,
      { metrics, priority: "foreground" },
      { signal },
    );
    this.ensureOk(response, data, true);
    return data;
  }

  async getCategories(solutionId: string, nodeId?: string, signal?: AbortSignal): Promise<unknown> {
    if (isIpcTransport()) {
      if (signal?.aborted) {
        throw new EngineError("aborted", 0, null);
      }
      let data: Record<string, unknown>;
      try {
        data = (await ipcCategories({
          nodeId: nodeId ?? "p0.t-1.r-1",
          solutionId,
          signal,
        })) as Record<string, unknown>;
      } catch (err) {
        if (signal?.aborted || isAbortError(err)) {
          throw new EngineError("aborted", 0, null);
        }
        throw err;
      }
      const served = hostedSolutionId(data.solution_id, solutionId);
      return {
        ...data,
        ...(served ? { solution_id: served } : {}),
        ...(nodeId || typeof data.node_id === "string"
          ? { node_id: typeof data.node_id === "string" ? data.node_id : nodeId }
          : {}),
      };
    }
    const path = nodeId
      ? `/api/solutions/${solutionId}/nodes/${encodeURIComponent(nodeId)}/categories`
      : `/api/solutions/${solutionId}/categories`;
    const { response, data } = await this.request("GET", path, undefined, { signal });
    this.ensureOk(response, data, true);
    return data;
  }

  /** Host fat Compare-runouts report (`line_card_report`). IPC only. */
  async getLineCardReport(
    solutionId: string,
    nodeId: string,
    opts?: { varyStreet?: "turn" | "river"; signal?: AbortSignal },
  ): Promise<unknown> {
    if (!isIpcTransport()) {
      throw new EngineError("line_card_report requires solver-engine IPC", 501, null);
    }
    if (opts?.signal?.aborted) {
      throw new EngineError("aborted", 0, null);
    }
    let data: Record<string, unknown>;
    try {
      data = (await ipcLineCardReport({
        nodeId,
        varyStreet: opts?.varyStreet,
        solutionId,
        signal: opts?.signal,
      })) as Record<string, unknown>;
    } catch (err) {
      if (opts?.signal?.aborted || isAbortError(err)) {
        throw new EngineError("aborted", 0, null);
      }
      throw err;
    }
    const served = hostedSolutionId(data.solution_id, solutionId);
    return {
      ...data,
      ...(served ? { solution_id: served } : {}),
      node_id: typeof data.node_id === "string" ? data.node_id : nodeId,
    };
  }

  /** Host Value/Bluffs after-call equity join (`value_bluffs_post_call`). IPC only. */
  async getValueBluffsPostCall(
    solutionId: string,
    nodeId: string,
    opts?: { minBetFreq?: number; signal?: AbortSignal },
  ): Promise<unknown> {
    if (!isIpcTransport()) {
      throw new EngineError("value_bluffs_post_call requires solver-engine IPC", 501, null);
    }
    if (opts?.signal?.aborted) {
      throw new EngineError("aborted", 0, null);
    }
    let data: Record<string, unknown>;
    try {
      data = (await ipcValueBluffsPostCall({
        nodeId,
        minBetFreq: opts?.minBetFreq,
        solutionId,
        signal: opts?.signal,
      })) as Record<string, unknown>;
    } catch (err) {
      if (opts?.signal?.aborted || isAbortError(err)) {
        throw new EngineError("aborted", 0, null);
      }
      throw err;
    }
    const served = hostedSolutionId(data.solution_id, solutionId);
    return {
      ...data,
      ...(served ? { solution_id: served } : {}),
      node_id: typeof data.node_id === "string" ? data.node_id : nodeId,
    };
  }

  /** Poll status until a file/solve overlay leaves `running` (fixture HTTP path). */
  private async waitUntilIdle(signal?: AbortSignal): Promise<StatusPayload> {
    for (let attempt = 0; attempt < 600; ++attempt) {
      if (signal?.aborted) {
        throw new DOMException("signal is aborted without reason", "AbortError");
      }
      const status = await this.status(signal);
      if (!status.running) {
        const errorText =
          typeof status.error === "string" && status.error.length > 0 ? status.error : "";
        if (errorText) {
          throw new EngineError(errorText, 400, status);
        }
        return status;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new EngineError("timed out waiting for engine job", 504, null);
  }

  async save(
    solutionId: string,
    path: string,
    options?: { studyOnly?: boolean; signal?: AbortSignal },
  ): Promise<unknown> {
    const signal = options?.signal;
    const studyOnly = options?.studyOnly === true;
    if (isIpcTransport()) {
      if (signal?.aborted) {
        throw new EngineError("aborted", 0, null);
      }
      try {
        return await ipcSave(path, { studyOnly, solutionId });
      } catch (err) {
        if (err instanceof EngineError) throw err;
        throw new EngineError(err instanceof Error ? err.message : String(err), 0, null);
      }
    }
    const { response, data } = await this.request(
      "POST",
      `/api/solutions/${solutionId}/save`,
      studyOnly ? { path, study_only: true } : { path },
      { signal },
    );
    this.ensureOk(response, data, true);
    if (response.status === 202) {
      await this.waitUntilIdle(signal);
      return { saved: true };
    }
    return data;
  }

  async open(path: string, signal?: AbortSignal): Promise<StatusPayload> {
    if (isIpcTransport()) {
      if (signal?.aborted) {
        throw new EngineError("aborted", 0, null);
      }
      let data: unknown;
      try {
        data = await ipcOpen(path);
      } catch (err) {
        if (err instanceof EngineError) throw err;
        throw new EngineError(err instanceof Error ? err.message : String(err), 0, null);
      }
      try {
        // Successful replacement: drop job book and clear job-local targets /
        // terminal errors while preserving checkpoint metadata on the payload.
        this.clearLastStudyJobId();
        return applyOpenJobLocalReset(
          decodeStatusPayload(data) as StatusPayload & Record<string, unknown>,
        ) as StatusPayload;
      } catch (err) {
        throw new EngineError(err instanceof Error ? err.message : String(err), 0, data);
      }
    }
    const { response, data } = await this.request("POST", "/api/open", { path }, { signal });
    this.ensureOk(response, data, true);
    if (response.status === 202) {
      const idle = await this.waitUntilIdle(signal);
      this.clearLastStudyJobId();
      return applyOpenJobLocalReset(
        idle as StatusPayload & Record<string, unknown>,
      ) as StatusPayload;
    }
    try {
      this.clearLastStudyJobId();
      return applyOpenJobLocalReset(
        decodeStatusPayload(data) as StatusPayload & Record<string, unknown>,
      ) as StatusPayload;
    } catch (err) {
      throw new EngineError(
        err instanceof Error ? err.message : String(err),
        response.status,
        data,
      );
    }
  }

  /** Spot config for a loaded solution (ranges, bets, tree edits, optional settings). */
  async getSolutionConfig(solutionId: string): Promise<Record<string, unknown>> {
    if (isIpcTransport()) {
      const body = (await ipcGetConfig(solutionId)) as {
        street_config_text?: string;
        solution_id?: string | number;
      };
      const text = typeof body.street_config_text === "string" ? body.street_config_text : "";
      if (!text.trim()) {
        throw new EngineError("solution config unavailable", 404, body);
      }
      return parseStreetConfigTextToSolutionConfig(text);
    }
    const { response, data } = await this.request(
      "GET",
      `/api/solutions/${solutionId}/config`,
    );
    this.ensureOk(response, data);
    return data as Record<string, unknown>;
  }

  async recentSolutions(): Promise<unknown> {
    // Library FS reads are Tauri-owned — do not require a live IPC session.
    if (isTauriRuntime() || isIpcTransport()) {
      return libraryInvoke("library_list_recent");
    }
    const { response, data } = await this.request("GET", "/api/recent-solutions");
    this.ensureOk(response, data);
    return data;
  }

  async templates(): Promise<unknown> {
    if (isTauriRuntime() || isIpcTransport()) {
      return libraryInvoke("library_list_templates");
    }
    const { response, data } = await this.request("GET", "/api/templates");
    this.ensureOk(response, data);
    return data;
  }

  async template(id: string): Promise<{ id: string; text: string }> {
    if (isTauriRuntime() || isIpcTransport()) {
      return libraryInvoke("library_read_template", { id });
    }
    const { response, data } = await this.request("GET", `/api/templates/${encodeURIComponent(id)}`);
    this.ensureOk(response, data);
    return data as { id: string; text: string };
  }

  async ranges(): Promise<unknown> {
    if (isTauriRuntime() || isIpcTransport()) {
      return libraryInvoke("library_list_ranges");
    }
    const { response, data } = await this.request("GET", "/api/ranges");
    this.ensureOk(response, data);
    return data;
  }

  async rangePreset(id: string): Promise<{ id: string; text: string }> {
    if (isTauriRuntime() || isIpcTransport()) {
      return libraryInvoke("library_read_range", { id });
    }
    const { response, data } = await this.request("GET", `/api/ranges/${encodeURIComponent(id)}`);
    this.ensureOk(response, data);
    return data as { id: string; text: string };
  }

  async parseConfig(text: string): Promise<Record<string, unknown>> {
    if (isIpcTransport()) {
      // Client-side only: templates are already local text; reuse the TS parser
      // (no host op / no solver_engine_request).
      try {
        return parseStreetConfigTextToSolutionConfig(text);
      } catch (err) {
        throw new EngineError(
          err instanceof Error ? err.message : String(err),
          400,
          null,
        );
      }
    }
    const { response, data } = await this.request("POST", "/api/config", { text });
    this.ensureOk(response, data);
    return data as Record<string, unknown>;
  }

  async treePreview(job: SolveJobRequest | { text: string }): Promise<TreePreviewPayload> {
    if (isIpcTransport()) {
      const configText = streetConfigTextFromPreviewJob(job);
      return (await ipcTreePreview(configText)) as TreePreviewPayload;
    }
    const { response, data } = await this.request("POST", "/api/tree-preview", job);
    this.ensureOk(response, data);
    return data as TreePreviewPayload;
  }

  async compare(baseline: string, scenario: string, nodeId: string): Promise<unknown> {
    if (isIpcTransport()) {
      return ipcCompare({ baseline, scenario, nodeId });
    }
    const query = new URLSearchParams({ baseline, scenario, node_id: nodeId });
    const { response, data } = await this.request("GET", `/api/compare?${query}`);
    this.ensureOk(response, data);
    return data;
  }

  async listLocks(solutionId: string): Promise<unknown> {
    if (isIpcTransport()) {
      return ipcListLocks(solutionId);
    }
    const { response, data } = await this.request(
      "GET",
      `/api/solutions/${solutionId}/locks`,
    );
    this.ensureOk(response, data);
    return data;
  }

  async putLock(
    solutionId: string,
    body: {
      node_id: string;
      kind: "full" | "selected";
      /** Default on the engine is "node" (selected board only). */
      scope?: "node" | "line";
      hand_indices?: number[];
      probs: number[];
      combo_probs?: number[][];
    },
  ): Promise<unknown> {
    if (isIpcTransport()) {
      return ipcPutLock(body, solutionId);
    }
    const { response, data } = await this.request(
      "PUT",
      `/api/solutions/${solutionId}/locks`,
      body,
    );
    this.ensureOk(response, data);
    return data;
  }

  async deleteLock(
    solutionId: string,
    nodeId?: string,
    handIndex?: number,
    scope?: "node" | "line",
  ): Promise<unknown> {
    if (isIpcTransport()) {
      return ipcDeleteLock({ nodeId, handIndex, scope, solutionId });
    }
    const query = new URLSearchParams();
    if (nodeId) {
      query.set("node_id", nodeId);
    }
    if (handIndex !== undefined) {
      query.set("hand_index", String(handIndex));
    }
    if (scope) {
      query.set("scope", scope);
    }
    const suffix = query.toString() ? `?${query}` : "";
    const { response, data } = await this.request(
      "DELETE",
      `/api/solutions/${solutionId}/locks${suffix}`,
    );
    this.ensureOk(response, data);
    return data;
  }

  async listStrategyEdits(solutionId: string): Promise<unknown> {
    if (isIpcTransport()) {
      return ipcListStrategyEdits(solutionId);
    }
    const { response, data } = await this.request(
      "GET",
      `/api/solutions/${solutionId}/strategy-edits`,
    );
    this.ensureOk(response, data);
    return data;
  }

  async putStrategyEdit(
    solutionId: string,
    body: {
      node_id: string;
      kind: "full" | "selected";
      hand_indices?: number[];
      probs: number[];
    },
  ): Promise<unknown> {
    if (isIpcTransport()) {
      return ipcPutStrategyEdit(body, solutionId);
    }
    const { response, data } = await this.request(
      "PUT",
      `/api/solutions/${solutionId}/strategy-edits`,
      body,
    );
    this.ensureOk(response, data);
    return data;
  }

  async deleteStrategyEdit(
    solutionId: string,
    nodeId?: string,
    handIndex?: number,
  ): Promise<unknown> {
    if (isIpcTransport()) {
      return ipcDeleteStrategyEdit({ nodeId, handIndex, solutionId });
    }
    const query = new URLSearchParams();
    if (nodeId) {
      query.set("node_id", nodeId);
    }
    if (handIndex !== undefined) {
      query.set("hand_index", String(handIndex));
    }
    const suffix = query.toString() ? `?${query}` : "";
    const { response, data } = await this.request(
      "DELETE",
      `/api/solutions/${solutionId}/strategy-edits${suffix}`,
    );
    this.ensureOk(response, data);
    return data;
  }

  /** Standalone equity calculator job (no solution required). Distinct from Study `equity`. */
  async startEquityJob(
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ job_id: string; state: string }> {
    if (isIpcTransport()) {
      if (signal?.aborted) {
        throw new EngineError("aborted", 0, null);
      }
      const data = await ipcStartEquityJob(body);
      const record =
        data && typeof data === "object" ? (data as Record<string, unknown>) : null;
      const jobId = typeof record?.job_id === "string" ? record.job_id.trim() : "";
      if (!jobId) {
        // Fixture/demo handlers that return `{}` for unknown ops used to leave
        // Equity stuck on "queued" with no pollable id — fail loudly instead.
        throw new EngineError("start_equity_job returned no job_id", 0, data);
      }
      const state = typeof record?.state === "string" ? record.state : "queued";
      return { job_id: jobId, state };
    }
    // Packaged Study never uses HTTP equity jobs (no explore :8765).
    if (isTauriRuntime()) {
      throw new EngineError(
        "Equity calculator requires solver-engine IPC — reconnect the engine",
        0,
        null,
      );
    }
    const { response, data } = await this.request("POST", "/api/equity/jobs", body, { signal });
    this.ensureOk(response, data, true);
    const record =
      data && typeof data === "object" ? (data as Record<string, unknown>) : null;
    const jobId = typeof record?.job_id === "string" ? record.job_id.trim() : "";
    if (!jobId) {
      throw new EngineError("start equity job returned no job_id", 0, data);
    }
    const state = typeof record?.state === "string" ? record.state : "queued";
    return { job_id: jobId, state };
  }

  async getEquityJob(jobId: string, signal?: AbortSignal): Promise<unknown> {
    const id = jobId.trim();
    if (!id) {
      throw new EngineError("equity job id required", 400, null);
    }
    if (isIpcTransport()) {
      if (signal?.aborted) {
        throw new EngineError("aborted", 0, null);
      }
      return ipcGetEquityJob(id);
    }
    if (isTauriRuntime()) {
      throw new EngineError(
        "Equity calculator requires solver-engine IPC — reconnect the engine",
        0,
        null,
      );
    }
    const { response, data } = await this.request(
      "GET",
      `/api/equity/jobs/${encodeURIComponent(id)}`,
      undefined,
      { signal },
    );
    this.ensureOk(response, data);
    return data;
  }

  async cancelEquityJob(jobId: string): Promise<unknown> {
    const id = jobId.trim();
    if (!id) {
      throw new EngineError("equity job id required", 400, null);
    }
    if (isIpcTransport()) {
      return ipcCancelEquityJob(id);
    }
    if (isTauriRuntime()) {
      throw new EngineError(
        "Equity calculator requires solver-engine IPC — reconnect the engine",
        0,
        null,
      );
    }
    const { response, data } = await this.request(
      "POST",
      `/api/equity/jobs/${encodeURIComponent(id)}/cancel`,
      {},
    );
    this.ensureOk(response, data);
    return data;
  }
}

/** Shared client; base URL resolved per request so Tauri detection is not racey. */
export const engineClient = new EngineClient();
