import { invoke } from "@tauri-apps/api/core";
import type {
  ActionValuesPayload,
  MemoryPlanPayload,
  NodePayload,
  SolveJobRequest,
  StatusPayload,
  TreePreviewPayload,
} from "../domain/types";
import { presentUserText } from "../domain/userText";
import { isTauriRuntime } from "../platform";
import { decodeErrorPayload } from "./contracts/error";
import { decodeReadyPayload, type ReadyPayload } from "./contracts/ready";
import { decodeStatusPayload } from "./contracts/status";
import { normalizeRunoutsPayload, type RunoutsModel } from "./runouts";
import { formatSolveJobStreetConfig } from "./streetConfigText";
import {
  ipcBeginConfig,
  ipcCancel,
  ipcDeleteLock,
  ipcEquity,
  ipcListLocks,
  ipcNode,
  ipcOpen,
  ipcPause,
  ipcPutLock,
  ipcSave,
  ipcSolve,
  ipcStatus,
  ipcValues,
  isIpcTransport,
} from "./transport";

function defaultEngineBaseUrl(): string {
  const fromEnv = import.meta.env.VITE_ENGINE_URL;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv;
  }
  // Packaged Study uses solver-engine IPC — never default to explorer :8765.
  // Browser/dev may still set VITE_ENGINE_URL for fixture/HTTP unit tests only.
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

  constructor(options: EngineClientOptions = {}) {
    this.constructorBaseUrl =
      options.baseUrl !== undefined ? options.baseUrl.replace(/\/$/, "") : undefined;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
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
    // Packaged Zig path must never fall through to explorer HTTP (:8765).
    if (isIpcTransport()) {
      throw new EngineError(
        `HTTP ${method} ${path} is unavailable over solver-engine IPC`,
        501,
        null,
      );
    }
    // Empty base URL + fetch("") paints "Engine unreachable: Failed to fetch"
    // (same class as #288). Refuse before dialing — HTTP is test/fixture only.
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

  async ready(signal?: AbortSignal): Promise<ReadyPayload> {
    const { response, data } = await this.request("GET", "/api/ready", undefined, { signal });
    this.ensureOk(response, data);
    try {
      return decodeReadyPayload(data);
    } catch (err) {
      throw new EngineError(
        err instanceof Error ? err.message : String(err),
        response.status,
        data,
      );
    }
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
      // Host train replies when finished (async worker; Tauri RPC wall 240s).
      // Prefer job.time_limit as a soft note only — host cancel/time_limit TBD.
      await ipcBeginConfig(configText);
      if (signal?.aborted) {
        throw new EngineError("aborted", 0, null);
      }
      const body = (await ipcSolve(iterations, "j-study")) as {
        solution_id?: number;
        policy_revision?: number;
        trained?: number;
      };
      return {
        running: false,
        job_id: "j-study",
        solution_id:
          body.solution_id != null && body.solution_id > 0
            ? `s${body.solution_id}`
            : null,
        policy_revision: body.policy_revision ?? 0,
        trained: body.trained ?? iterations,
        transport: "ipc",
      };
    }
    const { response, data } = await this.request("POST", "/api/solve", job, { signal });
    this.ensureOk(response, data, true);
    return data;
  }

  async pause(jobId?: string): Promise<unknown> {
    if (isIpcTransport()) {
      return ipcPause(jobId ?? null);
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
   * On IPC this maps to host `cancel` (job cancel), not HTTP stop-and-keep.
   * Missing jobId defaults to the Study train id (`j-study`).
   */
  async stop(jobId?: string): Promise<unknown> {
    if (isIpcTransport()) {
      return ipcCancel(jobId ?? null);
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

  async getRunouts(
    solutionId: string,
    nodeId: string,
    signal?: AbortSignal,
  ): Promise<RunoutsModel> {
    const { response, data } = await this.request(
      "GET",
      `/api/solutions/${solutionId}/nodes/${encodeURIComponent(nodeId)}/runouts`,
      undefined,
      { signal },
    );
    this.ensureOk(response, data, true);
    return normalizeRunoutsPayload(data);
  }

  async getEquity(solutionId: string, nodeId?: string, signal?: AbortSignal): Promise<unknown> {
    if (isIpcTransport()) {
      if (signal?.aborted) {
        throw new EngineError("aborted", 0, null);
      }
      // Host equity resolves Study node_id for identity; math is still
      // starting-range/board check-down (strategy-reach residual).
      const data = await ipcEquity(
        nodeId ? { nodeId } : { nodeIndex: 0, nodeId: "p0.t-1.r-1" },
      );
      return {
        ...(data as object),
        solution_id: solutionId,
        ...(nodeId ? { node_id: nodeId } : {}),
        pending: false,
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
    metrics: Array<"values" | "equity" | "runouts"> = ["values", "equity"],
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (isIpcTransport()) {
      if (signal?.aborted) {
        throw new EngineError("aborted", 0, null);
      }
      // Thin sync warm: Study still polls getValues/getEquity. No 202 job handle yet.
      // Skip runouts on IPC until a host op exists.
      const wanted = metrics.filter((m) => m === "values" || m === "equity");
      void nodeId;
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

  /** Passive read of Study analysis handle state (never starts work). */
  async getNodeAnalysis(
    solutionId: string,
    nodeId: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const { response, data } = await this.request(
      "GET",
      `/api/solutions/${solutionId}/nodes/${encodeURIComponent(nodeId)}/analysis`,
      undefined,
      { signal },
    );
    this.ensureOk(response, data, true);
    return data;
  }

  async getCategories(solutionId: string, nodeId?: string, signal?: AbortSignal): Promise<unknown> {
    const path = nodeId
      ? `/api/solutions/${solutionId}/nodes/${encodeURIComponent(nodeId)}/categories`
      : `/api/solutions/${solutionId}/categories`;
    const { response, data } = await this.request("GET", path, undefined, { signal });
    this.ensureOk(response, data, true);
    return data;
  }

  /** Poll `/api/status` until a file/solve overlay leaves `running`. */
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
    throw new EngineError("timed out waiting for explorer job", 504, null);
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
      throw new EngineError(
        "parseConfig is not available over solver-engine IPC yet (Library apply-template residual)",
        501,
        null,
      );
    }
    const { response, data } = await this.request("POST", "/api/config", { text });
    this.ensureOk(response, data);
    return data as Record<string, unknown>;
  }

  async planMemory(job: SolveJobRequest | { text: string }): Promise<MemoryPlanPayload> {
    if (isIpcTransport()) {
      throw new EngineError("planMemory is not available over solver-engine IPC yet", 501, null);
    }
    const { response, data } = await this.request("POST", "/api/plan-memory", job);
    this.ensureOk(response, data);
    return data as MemoryPlanPayload;
  }

  async treePreview(job: SolveJobRequest | { text: string }): Promise<TreePreviewPayload> {
    if (isIpcTransport()) {
      throw new EngineError("treePreview is not available over solver-engine IPC yet", 501, null);
    }
    const { response, data } = await this.request("POST", "/api/tree-preview", job);
    this.ensureOk(response, data);
    return data as TreePreviewPayload;
  }

  async compare(baseline: string, scenario: string, nodeId: string): Promise<unknown> {
    if (isIpcTransport()) {
      throw new EngineError("compare is not available over solver-engine IPC yet", 501, null);
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
    const { response, data } = await this.request("POST", "/api/equity/jobs", body, { signal });
    this.ensureOk(response, data, true);
    return data as { job_id: string; state: string };
  }

  async getEquityJob(jobId: string, signal?: AbortSignal): Promise<unknown> {
    const { response, data } = await this.request(
      "GET",
      `/api/equity/jobs/${encodeURIComponent(jobId)}`,
      undefined,
      { signal },
    );
    this.ensureOk(response, data);
    return data;
  }

  async getEquityJobResult(jobId: string, signal?: AbortSignal): Promise<unknown> {
    const { response, data } = await this.request(
      "GET",
      `/api/equity/jobs/${encodeURIComponent(jobId)}/result`,
      undefined,
      { signal },
    );
    this.ensureOk(response, data);
    return data;
  }

  async cancelEquityJob(jobId: string): Promise<unknown> {
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
