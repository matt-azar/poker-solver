/**
 * Study engine transport selection for the Zig rewrite path.
 *
 * Packaged Study uses `solver-engine` typed IPC (protocol 2) only.
 * `no-engine` is the browser / Vitest label when Tauri is absent (no sidecar).
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../platform";
import { SOLVER_ENGINE_PROTOCOL, SOLVER_ENGINE_SIDECAR } from "./ipcProtocol";

export type TransportKind = "ipc" | "no-engine";

export type IpcTransportInfo = {
  kind: "ipc";
  label: string;
  protocol: number;
  launchId: string;
  sidecar: string;
  workers: number;
};

export type NoEngineTransportInfo = {
  kind: "no-engine";
  label: string;
};

export type ActiveTransport = IpcTransportInfo | NoEngineTransportInfo;

const NO_ENGINE_LABEL =
  "no engine (browser/dev — Study requires Tauri + solver-engine IPC)";

let active: ActiveTransport = {
  kind: "no-engine",
  label: NO_ENGINE_LABEL,
};

export function getActiveTransport(): ActiveTransport {
  return active;
}

export function isIpcTransport(): boolean {
  return active.kind === "ipc";
}

export function setNoEngineTransport(reason?: string): NoEngineTransportInfo {
  active = {
    kind: "no-engine",
    label: reason?.trim() ? `${NO_ENGINE_LABEL}: ${reason}` : NO_ENGINE_LABEL,
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

/**
 * Framed request/reply via the Tauri-owned pipe ends.
 * Safe to overlap mid-train `values` with an in-flight `solve`: the shell
 * demuxes replies by `request_id` and does not hold the session mutex across
 * the blocking wait (host stdin already serves live-under-train).
 */
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
  const env = raw as IpcRequestEnvelope;
  if (env.ok === false) {
    const detail =
      (typeof env.error_message === "string" && env.error_message.trim()) ||
      (typeof env.error_code === "string" && env.error_code.trim()) ||
      `${op} failed`;
    throw new Error(detail);
  }
  return env;
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

/** Study node id (`pN.tT.rR`) or legacy numeric node_index (root = 0). */
export async function ipcValues(nodeIdOrIndex: string | number = 0): Promise<unknown> {
  const body =
    typeof nodeIdOrIndex === "string"
      ? { node_id: nodeIdOrIndex }
      : { node_index: nodeIdOrIndex };
  const env = await solverEngineRequest("values", body);
  return env.body;
}

/** Study check-down equity (host `equity` → reach-weighted `checkdownEquityAtNode`). */
export async function ipcEquity(opts?: {
  nodeIndex?: number;
  nodeId?: string;
}): Promise<unknown> {
  const env = await solverEngineRequest("equity", {
    node_index: opts?.nodeIndex ?? 0,
    ...(opts?.nodeId ? { node_id: opts.nodeId } : {}),
  });
  return env.body;
}

/** Study node inspect (`pN.tT.rR`) or legacy numeric node_index (root = 0). */
export async function ipcNode(nodeIdOrIndex: string | number = 0): Promise<unknown> {
  const body =
    typeof nodeIdOrIndex === "string"
      ? { node_id: nodeIdOrIndex }
      : { node_index: nodeIdOrIndex };
  const env = await solverEngineRequest("node", body);
  return env.body;
}

export async function ipcPause(jobId?: string | null): Promise<unknown> {
  const env = await solverEngineRequest("pause", null, jobId ?? null);
  return env.body;
}

/**
 * Host cancel (Study stop). Requires a job_id minted by the client for the
 * active train (ZR-90). This is cancel-of-job; continue uses a fresh solve.
 */
export async function ipcCancel(jobId?: string | null): Promise<unknown> {
  if (!jobId) {
    throw new Error("cancel requires a job_id");
  }
  const env = await solverEngineRequest("cancel", null, jobId);
  return env.body;
}

let studyJobSeq = 0;

/** Mint a per-solve job id for Study IPC (ZR-90). */
export function mintStudyJobId(): string {
  studyJobSeq += 1;
  return `j${studyJobSeq}`;
}

/** Test helper — reset the Study job id counter. */
export function resetStudyJobIdCounterForTests(): void {
  studyJobSeq = 0;
}

export async function ipcOpen(path: string): Promise<unknown> {
  const env = await solverEngineRequest("open", { path });
  return env.body;
}

export async function ipcSave(path: string): Promise<unknown> {
  const env = await solverEngineRequest("save", { path });
  return env.body;
}

/** Study locks list (`{"locks":[...]}`). */
export async function ipcListLocks(): Promise<unknown> {
  const env = await solverEngineRequest("list_locks");
  return env.body;
}

/** Upsert one node/line lock; reply is full locks list. */
export async function ipcPutLock(body: {
  node_id: string;
  kind: "full" | "selected";
  scope?: "node" | "line";
  hand_indices?: number[];
  probs: number[];
}): Promise<unknown> {
  const env = await solverEngineRequest("put_lock", body);
  return env.body;
}

/** Delete one lock / combo / all; reply is full locks list. */
export async function ipcDeleteLock(opts?: {
  nodeId?: string;
  handIndex?: number;
}): Promise<unknown> {
  const body: Record<string, unknown> = {};
  if (opts?.nodeId) body.node_id = opts.nodeId;
  if (opts?.handIndex !== undefined) body.hand_index = opts.handIndex;
  const env = await solverEngineRequest(
    "delete_lock",
    Object.keys(body).length > 0 ? body : null,
  );
  return env.body;
}

/** Study strategy-edits list (`{"edits":[...],"persisted":false}`). */
export async function ipcListStrategyEdits(): Promise<unknown> {
  const env = await solverEngineRequest("list_strategy_edits");
  return env.body;
}

/** Upsert one free-form strategy edit; reply is full edits list. */
export async function ipcPutStrategyEdit(body: {
  node_id: string;
  kind: "full" | "selected";
  hand_indices?: number[];
  probs: number[];
}): Promise<unknown> {
  const env = await solverEngineRequest("put_strategy_edit", body);
  return env.body;
}

/** Delete one edit / combo / all; reply is full edits list. */
export async function ipcDeleteStrategyEdit(opts?: {
  nodeId?: string;
  handIndex?: number;
}): Promise<unknown> {
  const body: Record<string, unknown> = {};
  if (opts?.nodeId) body.node_id = opts.nodeId;
  if (opts?.handIndex !== undefined) body.hand_index = opts.handIndex;
  const env = await solverEngineRequest(
    "delete_strategy_edit",
    Object.keys(body).length > 0 ? body : null,
  );
  return env.body;
}

export async function ipcBeginConfig(configText: string): Promise<unknown> {
  const env = await solverEngineRequest("begin_config", { config_text: configText });
  return env.body;
}

export async function ipcGetConfig(): Promise<unknown> {
  const env = await solverEngineRequest("get_config");
  return env.body;
}

/** Side-effect-free public tree + nested memory plan (ZR-83). */
export async function ipcTreePreview(configText: string): Promise<unknown> {
  const env = await solverEngineRequest("tree_preview", { config_text: configText });
  return env.body;
}

/** Side-effect-free memory plan only (ZR-83). */
export async function ipcPlanMemory(configText: string): Promise<unknown> {
  const env = await solverEngineRequest("plan_memory", { config_text: configText });
  return env.body;
}

export type IpcSolveOptions = {
  iterations: number;
  accuracy?: number;
  time_limit?: number;
  eval_every?: number;
  jobId?: string | null;
};

export async function ipcSolve(
  iterationsOrOpts: number | IpcSolveOptions,
  jobId?: string,
): Promise<unknown> {
  const opts: IpcSolveOptions =
    typeof iterationsOrOpts === "number"
      ? { iterations: iterationsOrOpts, jobId: jobId ?? null }
      : iterationsOrOpts;
  const body: Record<string, unknown> = {
    iterations: Math.max(1, Math.trunc(opts.iterations || 1)),
  };
  if (opts.accuracy != null && Number.isFinite(opts.accuracy) && opts.accuracy > 0) {
    body.accuracy = opts.accuracy;
  }
  if (opts.time_limit != null && Number.isFinite(opts.time_limit) && opts.time_limit >= 0) {
    body.time_limit = opts.time_limit;
  }
  if (opts.eval_every != null && Number.isFinite(opts.eval_every) && opts.eval_every > 0) {
    body.eval_every = Math.trunc(opts.eval_every);
  }
  const env = await solverEngineRequest("solve", body, opts.jobId ?? null);
  return env.body;
}

export type IpcResolveLockedOptions = {
  iterations: number;
  warm_start?: number;
  accuracy?: number;
  samples?: number;
  time_limit?: number;
  jobId?: string | null;
};

/** Locked re-solve: host stamps baseline, optional reset, trains under locks. */
export async function ipcResolveLocked(opts: IpcResolveLockedOptions): Promise<unknown> {
  const body: Record<string, unknown> = {
    iterations: Math.max(1, Math.trunc(opts.iterations || 1)),
    warm_start: opts.warm_start ? 1 : 0,
  };
  if (opts.accuracy != null && Number.isFinite(opts.accuracy) && opts.accuracy > 0) {
    body.accuracy = opts.accuracy;
  }
  if (opts.samples != null && Number.isFinite(opts.samples) && opts.samples > 0) {
    body.samples = Math.trunc(opts.samples);
  }
  if (opts.time_limit != null && Number.isFinite(opts.time_limit) && opts.time_limit >= 0) {
    body.time_limit = opts.time_limit;
  }
  const env = await solverEngineRequest("resolve_locked", body, opts.jobId ?? null);
  return env.body;
}

/** Standalone Equity calculator job start (ZR-84; no Study session). */
export async function ipcStartEquityJob(body: Record<string, unknown>): Promise<unknown> {
  const env = await solverEngineRequest("start_equity_job", body);
  return env.body;
}

/** Poll Equity calculator job status / embedded result. */
export async function ipcGetEquityJob(jobId: string): Promise<unknown> {
  const env = await solverEngineRequest("get_equity_job", { job_id: jobId });
  return env.body;
}

/** Cancel / stop an Equity calculator job. */
export async function ipcCancelEquityJob(jobId: string): Promise<unknown> {
  const env = await solverEngineRequest("cancel_equity_job", { job_id: jobId });
  return env.body;
}

/** Study Categories (made-hand on five-card boards; host `categories`). */
export async function ipcCategories(opts?: {
  nodeIndex?: number;
  nodeId?: string;
}): Promise<unknown> {
  const env = await solverEngineRequest("categories", {
    node_index: opts?.nodeIndex ?? 0,
    ...(opts?.nodeId ? { node_id: opts.nodeId } : {}),
  });
  return env.body;
}
