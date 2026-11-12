/**
 * Study engine transport selection for the Zig rewrite path.
 *
 * Prefer `solver-engine` typed IPC (protocol 2). HTTP `holdem-explorer` is only
 * a temporary labeled fallback when the Zig sidecar is unavailable.
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../platform";
import { SOLVER_ENGINE_PROTOCOL, SOLVER_ENGINE_SIDECAR } from "./ipcProtocol";

export type TransportKind = "ipc" | "http-fallback";

export type IpcTransportInfo = {
  kind: "ipc";
  label: string;
  protocol: number;
  launchId: string;
  sidecar: string;
  workers: number;
};

export type HttpFallbackInfo = {
  kind: "http-fallback";
  label: string;
};

export type ActiveTransport = IpcTransportInfo | HttpFallbackInfo;

const HTTP_FALLBACK_LABEL =
  "HTTP explorer fallback (temporary — Zig path prefers solver-engine IPC)";

let active: ActiveTransport = {
  kind: "http-fallback",
  label: HTTP_FALLBACK_LABEL,
};

export function getActiveTransport(): ActiveTransport {
  return active;
}

export function isIpcTransport(): boolean {
  return active.kind === "ipc";
}

export function setHttpFallbackTransport(reason?: string): HttpFallbackInfo {
  active = {
    kind: "http-fallback",
    label: reason?.trim() ? `${HTTP_FALLBACK_LABEL}: ${reason}` : HTTP_FALLBACK_LABEL,
  };
  return active;
}

export function setIpcTransport(info: Omit<IpcTransportInfo, "kind" | "label">): IpcTransportInfo {
  active = {
    kind: "ipc",
    label: `solver-engine IPC (protocol ${info.protocol})`,
    protocol: info.protocol,
    launchId: info.launchId,
    sidecar: info.sidecar,
    workers: info.workers,
  };
  return active;
}

type SolverEngineInfoRaw = {
  status?: string;
  transport?: string;
  protocol?: number;
  launchId?: string;
  sidecar?: string;
  workers?: number;
};

function asSolverInfo(raw: unknown): SolverEngineInfoRaw | null {
  if (!raw || typeof raw !== "object") return null;
  return raw as SolverEngineInfoRaw;
}

/** Ask Tauri to spawn/ready solver-engine over inherited pipes. */
export async function ensureSolverEngineIpc(): Promise<IpcTransportInfo> {
  if (!isTauriRuntime()) {
    throw new Error("solver-engine IPC requires the Tauri shell");
  }
  const raw = await invoke("ensure_solver_engine");
  const info = asSolverInfo(raw);
  if (!info || info.protocol !== SOLVER_ENGINE_PROTOCOL) {
    throw new Error("ensure_solver_engine returned an incompatible ready payload");
  }
  return setIpcTransport({
    protocol: info.protocol ?? SOLVER_ENGINE_PROTOCOL,
    launchId: typeof info.launchId === "string" ? info.launchId : "",
    sidecar: typeof info.sidecar === "string" ? info.sidecar : SOLVER_ENGINE_SIDECAR,
    workers: typeof info.workers === "number" ? info.workers : 0,
  });
}

export type IpcRequestEnvelope = {
  v?: number;
  kind?: string;
  request_id?: string;
  job_id?: string | null;
  op?: string;
  ok?: boolean;
  error_code?: string | null;
  error_message?: string | null;
  body?: unknown;
};

/** Framed request/reply via the Tauri-owned pipe ends. */
export async function solverEngineRequest(
  op: string,
  body: unknown = null,
  jobId?: string | null,
): Promise<IpcRequestEnvelope> {
  if (!isTauriRuntime()) {
    throw new Error("solverEngineRequest requires the Tauri shell");
  }
  const raw = await invoke("solver_engine_request", {
    op,
    body,
    jobId: jobId ?? null,
  });
  if (!raw || typeof raw !== "object") {
    throw new Error("solver_engine_request returned a non-object");
  }
  return raw as IpcRequestEnvelope;
}

export async function ipcReady(): Promise<{
  protocol: number;
  sidecar: string;
  launch_id?: string;
  workers?: number;
}> {
  const env = await solverEngineRequest("ready");
  const body = (env.body ?? {}) as {
    protocol?: number;
    sidecar?: string;
    launch_id?: string;
    workers?: number;
  };
  return {
    protocol: body.protocol ?? SOLVER_ENGINE_PROTOCOL,
    sidecar: body.sidecar ?? SOLVER_ENGINE_SIDECAR,
    launch_id: body.launch_id,
    workers: body.workers,
  };
}

export async function ipcStatus(): Promise<unknown> {
  const env = await solverEngineRequest("status");
  return env.body;
}

export async function ipcValues(nodeIndex = 0): Promise<unknown> {
  const env = await solverEngineRequest("values", { node_index: nodeIndex });
  return env.body;
}

export async function ipcBeginConfig(configText: string): Promise<unknown> {
  const env = await solverEngineRequest("begin_config", { config_text: configText });
  return env.body;
}

export async function ipcSolve(iterations: number, jobId?: string): Promise<unknown> {
  const env = await solverEngineRequest("solve", { iterations }, jobId ?? null);
  return env.body;
}
