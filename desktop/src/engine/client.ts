import { invoke } from "@tauri-apps/api/core";
import type {
  ActionValuesPayload,
  NodePayload,
  SolveJobRequest,
  StatusPayload,
  TreePreviewPayload,
} from "../domain/types";
import { presentUserText } from "../domain/userText";
import { isTauriRuntime } from "../platform";
import { decodeErrorPayload } from "./contracts/error";
import { decodeStatusPayload } from "./contracts/status";
import { formatSolveJobStreetConfig, parseStreetConfigTextToSolutionConfig } from "./streetConfigText";
import {
  ipcBeginConfig,
  ipcCancel,
  ipcCancelEquityJob,
  ipcCategories,
  ipcDeleteLock,
  ipcDeleteStrategyEdit,
  ipcEquity,
  ipcGetConfig,
  ipcGetEquityJob,
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

export class EngineClient {
  private readonly constructorBaseUrl: string | undefined;
  private runtimeBaseUrl: string | undefined;
  private readonly fetchImpl: typeof fetch;
  /** Last minted Study train job id (ZR-90 stop/cancel). */
  private lastJobId: string | null = null;

  constructor(options: EngineClientOptions = {}) {
    this.constructorBaseUrl =
      options.baseUrl !== undefined ? options.baseUrl.replace(/\/$/, "") : undefined;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  }

  lastStudyJobId(): string | null {
    return this.lastJobId;
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
      if (signal?.aborted) {
        throw new EngineError("aborted", 0, null);
      }
      const data = await ipcStatus();
      try {
        return decodeStatusPayload(data);
      } catch (err) {
        throw new EngineError(err instanceof Error ? err.message : String(err), 0, data);
      }
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
      const iterations = Math.max(1, Math.trunc(job.iterations || 1));
      const jobId = mintStudyJobId();
      this.lastJobId = jobId;
      await ipcBeginConfig(configText);
      if (signal?.aborted) {
        throw new EngineError("aborted", 0, null);
      }
      const accuracy =
        typeof job.accuracy === "number" && Number.isFinite(job.accuracy)
          ? job.accuracy
          : undefined;
      const time_limit =
        typeof job.time_limit === "number" && Number.isFinite(job.time_limit)
          ? job.time_limit
          : undefined;
      const body = (await ipcSolve({
        iterations,
        accuracy,
        time_limit,
        jobId,
      })) as {
        accepted?: boolean;
        running?: boolean;
        solution_id?: number;
        policy_revision?: number;
        trained?: number;
        terminal_reason?: string;
        threads?: number;
      };
      // Host short-admits train (ZR-90/ZR-106); Study polls status for completion.
      const admitted = body.accepted === true || body.running === true;
      return {
        running: admitted ? true : false,
        job_id: jobId,
        solution_id:
          body.solution_id != null && body.solution_id > 0
            ? `s${body.solution_id}`
            : null,
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
      return ipcPause(jobId ?? this.lastJobId);
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
   * Missing jobId uses the last minted Study train id (ZR-90).
   */
  async stop(jobId?: string): Promise<unknown> {
    if (isIpcTransport()) {
      const id = jobId ?? this.lastJobId;
      if (!id) {
        throw new EngineError("no active study job to cancel", 400, null);
      }
      return ipcCancel(id);
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
    body: { iterations: number; time_limit?: number },
  ): Promise<unknown> {
    if (isIpcTransport()) {
      // Host has no dedicated `continue` op: resume training on the open
      // session via `solve` (begin_config would wipe the trainer / has_training).
      // Mint a fresh job id (ZR-90); host rejects browse-only via has_training.
      void solutionId;
      const iterations = Math.max(1, Math.trunc(body.iterations || 1));
      const jobId = mintStudyJobId();
      this.lastJobId = jobId;
      const time_limit =
        typeof body.time_limit === "number" && Number.isFinite(body.time_limit)
          ? body.time_limit
          : undefined;
      const reply = (await ipcSolve({
        iterations,
        time_limit,
        jobId,
      })) as {
        accepted?: boolean;
        running?: boolean;
        solution_id?: number;
        policy_revision?: number;
        trained?: number;
        terminal_reason?: string;
        threads?: number;
      };
      const admitted = reply.accepted === true || reply.running === true;
      return {
        running: admitted ? true : false,
        job_id: jobId,
        solution_id:
          reply.solution_id != null && reply.solution_id > 0
            ? `s${reply.solution_id}`
            : solutionId,
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
      const iterations = Math.max(1, Math.trunc(body.iterations || 1));
      const jobId = mintStudyJobId();
      this.lastJobId = jobId;
      const time_limit =
        typeof body.time_limit === "number" && Number.isFinite(body.time_limit)
          ? body.time_limit
          : undefined;
      const accuracy =
        typeof body.accuracy === "number" && Number.isFinite(body.accuracy)
          ? body.accuracy
          : undefined;
      const samples =
        typeof body.samples === "number" && Number.isFinite(body.samples)
          ? body.samples
          : undefined;
      const reply = (await ipcResolveLocked({
        iterations,
        warm_start: body.warm_start ? 1 : 0,
        accuracy,
        samples,
        time_limit,
        jobId,
      })) as {
        accepted?: boolean;
        running?: boolean;
        solution_id?: number;
        policy_revision?: number;
        trained?: number;
        terminal_reason?: string;
        threads?: number;
      };
      const admitted = reply.accepted === true || reply.running === true;
      return {
        running: admitted ? true : false,
        job_id: jobId,
        solution_id:
          reply.solution_id != null && reply.solution_id > 0
            ? `s${reply.solution_id}`
            : solutionId,
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
      const data = await ipcNode(nodeId);
      return {
        ...(data as object),
        solution_id: solutionId,
        node_id: nodeId,
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
      const data = await ipcValues(nodeId);
      return {
        ...(data as object),
        solution_id: solutionId,
        node_id: nodeId,
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
      const data = await ipcEquity(
        nodeId ? { nodeId } : { nodeIndex: 0, nodeId: "p0.t-1.r-1" },
      );
      return {
        ...(data as object),
        solution_id: solutionId,
        ...(nodeId ? { node_id: nodeId } : { node_id: "p0.t-1.r-1" }),
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
      const data = await ipcCategories({
        nodeId: nodeId ?? "p0.t-1.r-1",
      });
      return {
        ...(data as object),
        solution_id: solutionId,
        ...(nodeId ? { node_id: nodeId } : {}),
      };
    }
    const path = nodeId
      ? `/api/solutions/${solutionId}/nodes/${encodeURIComponent(nodeId)}/categories`
      : `/api/solutions/${solutionId}/categories`;
    const { response, data } = await this.request("GET", path, undefined, { signal });
    this.ensureOk(response, data, true);
    return data;
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

  async save(solutionId: string, path: string, signal?: AbortSignal): Promise<unknown> {
    if (isIpcTransport()) {
      if (signal?.aborted) {
        throw new EngineError("aborted", 0, null);
      }
      // Host save is sync; solutionId is Study-side identity (host uses current session).
      void solutionId;
      return ipcSave(path);
    }
    const { response, data } = await this.request(
      "POST",
      `/api/solutions/${solutionId}/save`,
      { path },
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
      const data = await ipcOpen(path);
      try {
        return decodeStatusPayload(data);
      } catch (err) {
        throw new EngineError(err instanceof Error ? err.message : String(err), 0, data);
      }
    }
    const { response, data } = await this.request("POST", "/api/open", { path }, { signal });
    this.ensureOk(response, data, true);
    if (response.status === 202) {
      return this.waitUntilIdle(signal);
    }
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

  /** Spot config for a loaded solution (ranges, bets, tree edits, optional settings). */
  async getSolutionConfig(solutionId: string): Promise<Record<string, unknown>> {
    if (isIpcTransport()) {
      void solutionId;
      const body = (await ipcGetConfig()) as { street_config_text?: string };
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
      void baseline;
      void scenario;
      void nodeId;
      // Dual-session immutable baseline is deferred (audit §6). Soft-gate UI
      // should avoid calling this; keep a clear 501 if something still does.
      throw new EngineError(
        "Compare needs an immutable dual-session baseline; not available over Zig IPC yet",
        501,
        { code: "compare_dual_session_deferred" },
      );
    }
    const query = new URLSearchParams({ baseline, scenario, node_id: nodeId });
    const { response, data } = await this.request("GET", `/api/compare?${query}`);
    this.ensureOk(response, data);
    return data;
  }

  async listLocks(solutionId: string): Promise<unknown> {
    if (isIpcTransport()) {
      // Host Session is single-solution; solutionId is Study-side identity.
      void solutionId;
      return ipcListLocks();
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
    },
  ): Promise<unknown> {
    if (isIpcTransport()) {
      void solutionId;
      return ipcPutLock(body);
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
  ): Promise<unknown> {
    if (isIpcTransport()) {
      void solutionId;
      return ipcDeleteLock({ nodeId, handIndex });
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
      `/api/solutions/${solutionId}/locks${suffix}`,
    );
    this.ensureOk(response, data);
    return data;
  }

  async listStrategyEdits(solutionId: string): Promise<unknown> {
    if (isIpcTransport()) {
      // Host Session is single-solution; solutionId is Study-side identity.
      void solutionId;
      return ipcListStrategyEdits();
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
      void solutionId;
      return ipcPutStrategyEdit(body);
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
      void solutionId;
      return ipcDeleteStrategyEdit({ nodeId, handIndex });
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

  /** Standalone equity calculator job (no solution required). */
  async startEquityJob(
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ job_id: string; state: string }> {
    if (isIpcTransport()) {
      if (signal?.aborted) {
        throw new EngineError("aborted", 0, null);
      }
      const data = await ipcStartEquityJob(body);
      return data as { job_id: string; state: string };
    }
    const { response, data } = await this.request("POST", "/api/equity/jobs", body, { signal });
    this.ensureOk(response, data, true);
    return data as { job_id: string; state: string };
  }

  async getEquityJob(jobId: string, signal?: AbortSignal): Promise<unknown> {
    if (isIpcTransport()) {
      if (signal?.aborted) {
        throw new EngineError("aborted", 0, null);
      }
      return ipcGetEquityJob(jobId);
    }
    const { response, data } = await this.request(
      "GET",
      `/api/equity/jobs/${encodeURIComponent(jobId)}`,
      undefined,
      { signal },
    );
    this.ensureOk(response, data);
    return data;
  }

  async cancelEquityJob(jobId: string): Promise<unknown> {
    if (isIpcTransport()) {
      return ipcCancelEquityJob(jobId);
    }
    const { response, data } = await this.request(
      "POST",
      `/api/equity/jobs/${encodeURIComponent(jobId)}/cancel`,
      {},
    );
    this.ensureOk(response, data);
    return data;
  }
}

/** Shared client; base URL resolved per request so Tauri detection is not racey. */
export const engineClient = new EngineClient();
