import type {
  ActionValuesPayload,
  NodePayload,
  SolveJobRequest,
  StatusPayload,
} from "../domain/types";
import { isTauriRuntime } from "../platform";

function defaultEngineBaseUrl(): string {
  const fromEnv = import.meta.env.VITE_ENGINE_URL;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv;
  }
  // Tauri webview origin is not the explorer; hit the managed local explorer.
  if (isTauriRuntime()) {
    return "http://127.0.0.1:8765";
  }
  return "";
}

export class EngineError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "EngineError";
    this.status = status;
    this.body = body;
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
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: EngineClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    init: RequestInit = {},
  ): Promise<{ response: Response; data: unknown }> {
    const headers = new Headers(init.headers);
    if (body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    const response = await this.fetchImpl(this.url(path), {
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
      data && typeof data === "object" && data !== null && "error" in data
        ? String((data as { error: unknown }).error)
        : response.statusText || `HTTP ${response.status}`;
    throw new EngineError(message, response.status, data);
  }

  async status(signal?: AbortSignal): Promise<StatusPayload> {
    const { response, data } = await this.request("GET", "/api/status", undefined, { signal });
    this.ensureOk(response, data);
    return data as StatusPayload;
  }

  async solve(job: SolveJobRequest, signal?: AbortSignal): Promise<unknown> {
    const { response, data } = await this.request("POST", "/api/solve", job, { signal });
    this.ensureOk(response, data, true);
    return data;
  }

  async pause(jobId?: string): Promise<unknown> {
    const { response, data } = await this.request(
      "POST",
      "/api/pause",
      jobId ? { job_id: jobId } : {},
    );
    this.ensureOk(response, data);
    return data;
  }

  async stop(jobId?: string): Promise<unknown> {
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
    const { response, data } = await this.request(
      "GET",
      `/api/solutions/${solutionId}/nodes/${encodeURIComponent(nodeId)}/values`,
      undefined,
      { signal },
    );
    this.ensureOk(response, data, true);
    return data as ActionValuesPayload;
  }

  async getRunouts(solutionId: string, nodeId: string, signal?: AbortSignal): Promise<unknown> {
    const { response, data } = await this.request(
      "GET",
      `/api/solutions/${solutionId}/nodes/${encodeURIComponent(nodeId)}/runouts`,
      undefined,
      { signal },
    );
    this.ensureOk(response, data, true);
    return data;
  }

  async getEquity(solutionId: string, nodeId?: string, signal?: AbortSignal): Promise<unknown> {
    const path = nodeId
      ? `/api/solutions/${solutionId}/nodes/${encodeURIComponent(nodeId)}/equity`
      : `/api/solutions/${solutionId}/equity`;
    const { response, data } = await this.request("GET", path, undefined, { signal });
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

  async save(solutionId: string, path: string): Promise<unknown> {
    const { response, data } = await this.request("POST", `/api/solutions/${solutionId}/save`, {
      path,
    });
    this.ensureOk(response, data);
    return data;
  }

  async open(path: string): Promise<unknown> {
    const { response, data } = await this.request("POST", "/api/open", { path });
    this.ensureOk(response, data);
    return data;
  }

  async recentSolutions(): Promise<unknown> {
    const { response, data } = await this.request("GET", "/api/recent-solutions");
    this.ensureOk(response, data);
    return data;
  }

  async templates(): Promise<unknown> {
    const { response, data } = await this.request("GET", "/api/templates");
    this.ensureOk(response, data);
    return data;
  }

  async template(id: string): Promise<{ id: string; text: string }> {
    const { response, data } = await this.request("GET", `/api/templates/${encodeURIComponent(id)}`);
    this.ensureOk(response, data);
    return data as { id: string; text: string };
  }

  async ranges(): Promise<unknown> {
    const { response, data } = await this.request("GET", "/api/ranges");
    this.ensureOk(response, data);
    return data;
  }

  async rangePreset(id: string): Promise<{ id: string; text: string }> {
    const { response, data } = await this.request("GET", `/api/ranges/${encodeURIComponent(id)}`);
    this.ensureOk(response, data);
    return data as { id: string; text: string };
  }

  async parseConfig(text: string): Promise<Record<string, unknown>> {
    const { response, data } = await this.request("POST", "/api/config", { text });
    this.ensureOk(response, data);
    return data as Record<string, unknown>;
  }

  async compare(baseline: string, scenario: string, nodeId: string): Promise<unknown> {
    const query = new URLSearchParams({ baseline, scenario, node_id: nodeId });
    const { response, data } = await this.request("GET", `/api/compare?${query}`);
    this.ensureOk(response, data);
    return data;
  }

  async listLocks(solutionId: string): Promise<unknown> {
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
      hand_indices?: number[];
      probs: number[];
    },
  ): Promise<unknown> {
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
}

export const engineClient = new EngineClient({ baseUrl: defaultEngineBaseUrl() });
