/**
 * IPC client for `solver-engine`.
 * Domain ops mirror EngineClient; transport is framed pipes (not HTTP).
 * Packaged Study uses this path only (no holdem-explorer fallback).
 */
import {
  encodeIpcFrame,
  makeRequest,
  tryDecodeIpcFrame,
  type IpcEnvelope,
  SOLVER_ENGINE_PROTOCOL,
} from "./ipcProtocol";

export type IpcByteWriter = (bytes: Uint8Array) => void | Promise<void>;
export type IpcByteReader = () => AsyncIterable<Uint8Array>;

export class SolverEngineIpcClient {
  private nextRequest = 1;
  private nextJob = 1;
  private readonly pending = new Map<
    string,
    { resolve: (env: IpcEnvelope) => void; reject: (err: Error) => void }
  >;
  private buffer = new Uint8Array(0);
  private pump: Promise<void> | null = null;
  private readonly write: IpcByteWriter;
  private readonly read: IpcByteReader;

  constructor(write: IpcByteWriter, read: IpcByteReader) {
    this.write = write;
    this.read = read;
  }

  start(): void {
    if (this.pump) return;
    this.pump = this.readLoop();
  }

  /** Fail all pending requests (sidecar exit — D1). */
  failPending(message = "solver-engine disconnected"): void {
    for (const [id, waiter] of this.pending) {
      waiter.reject(new Error(`${message} (${id})`));
    }
    this.pending.clear();
  }

  private async readLoop(): Promise<void> {
    try {
      for await (const chunk of this.read()) {
        const merged = new Uint8Array(this.buffer.length + chunk.length);
        merged.set(this.buffer);
        merged.set(chunk, this.buffer.length);
        this.buffer = merged;
        while (true) {
          const decoded = tryDecodeIpcFrame(this.buffer);
          if (!decoded) break;
          this.buffer = this.buffer.subarray(decoded.bytesConsumed);
          const env = decoded.envelope;
          if (env.kind === "progress") {
            // Progress events are available for status subscribers later.
            continue;
          }
          const waiter = this.pending.get(env.request_id);
          if (waiter) {
            this.pending.delete(env.request_id);
            if (env.ok === false) {
              waiter.reject(
                new Error(env.error_message ?? env.error_code ?? "ipc error"),
              );
            } else {
              waiter.resolve(env);
            }
          }
        }
      }
      this.failPending("solver-engine pipe closed");
    } catch (err) {
      this.failPending(err instanceof Error ? err.message : String(err));
    }
  }

  private async request(op: string, body: unknown = null, jobId?: string): Promise<IpcEnvelope> {
    this.start();
    const requestId = `r${this.nextRequest++}`;
    const envelope = makeRequest(requestId, op, body, jobId);
    const frame = encodeIpcFrame(envelope);
    const reply = new Promise<IpcEnvelope>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
    });
    await this.write(frame);
    return reply;
  }

  async ready(): Promise<{ protocol: number; sidecar: string; launch_id?: string }> {
    const env = await this.request("ready");
    const body = (env.body ?? {}) as {
      protocol?: number;
      sidecar?: string;
      launch_id?: string;
    };
    return {
      protocol: body.protocol ?? SOLVER_ENGINE_PROTOCOL,
      sidecar: body.sidecar ?? "solver-engine",
      launch_id: body.launch_id,
    };
  }

  async status(): Promise<unknown> {
    const env = await this.request("status");
    return env.body;
  }

  async beginConfig(configText: string): Promise<unknown> {
    const env = await this.request("begin_config", { config_text: configText });
    return env.body;
  }

  async solve(iterations: number, jobId?: string): Promise<unknown> {
    const jid = jobId ?? `j${this.nextJob++}`;
    const env = await this.request("solve", { iterations }, jid);
    return env.body;
  }

  async cancel(jobId: string): Promise<unknown> {
    const env = await this.request("cancel", null, jobId);
    return env.body;
  }

  async open(path: string): Promise<unknown> {
    const env = await this.request("open", { path });
    return env.body;
  }

  async save(path: string): Promise<unknown> {
    const env = await this.request("save", { path });
    return env.body;
  }

  /** Study node inspect. Accepts Study `pN.tT.rR` or legacy numeric index. */
  async node(nodeIdOrIndex: string | number = 0): Promise<unknown> {
    const body =
      typeof nodeIdOrIndex === "string"
        ? { node_id: nodeIdOrIndex }
        : { node_index: nodeIdOrIndex };
    const env = await this.request("node", body);
    return env.body;
  }

  /** Node action-EV tables (root-centered + local_offset). Accepts Study `pN.tT.rR` or index. */
  async values(nodeIdOrIndex: string | number = 0): Promise<unknown> {
    const body =
      typeof nodeIdOrIndex === "string"
        ? { node_id: nodeIdOrIndex }
        : { node_index: nodeIdOrIndex };
    const env = await this.request("values", body);
    return env.body;
  }

  /** Study check-down equity (histograms + compact hands). */
  async equity(nodeIdOrIndex: string | number = "p0.t-1.r-1"): Promise<unknown> {
    const body =
      typeof nodeIdOrIndex === "string"
        ? { node_id: nodeIdOrIndex }
        : { node_index: nodeIdOrIndex };
    const env = await this.request("equity", body);
    return env.body;
  }

  /** Study locks list. */
  async listLocks(): Promise<unknown> {
    const env = await this.request("list_locks");
    return env.body;
  }

  /** Upsert a lock; reply is full locks list. */
  async putLock(body: {
    node_id: string;
    kind: "full" | "selected";
    scope?: "node" | "line";
    hand_indices?: number[];
    probs: number[];
  }): Promise<unknown> {
    const env = await this.request("put_lock", body);
    return env.body;
  }

  /** Delete lock(s); reply is full locks list. */
  async deleteLock(opts?: { node_id?: string; hand_index?: number }): Promise<unknown> {
    const env = await this.request("delete_lock", opts ?? null);
    return env.body;
  }

  /** Resolve Locked: baseline stamp + optional reset + train under locks. */
  async resolveLocked(
    body: {
      iterations: number;
      warm_start?: number;
      accuracy?: number;
      samples?: number;
      time_limit?: number;
    },
    jobId?: string,
  ): Promise<unknown> {
    const env = await this.request("resolve_locked", body, jobId);
    return env.body;
  }

  /** Standalone Equity calculator job start (no Study session). */
  async startEquityJob(body: Record<string, unknown>): Promise<unknown> {
    const env = await this.request("start_equity_job", body);
    return env.body;
  }

  async getEquityJob(jobId: string): Promise<unknown> {
    const env = await this.request("get_equity_job", { job_id: jobId });
    return env.body;
  }

  async cancelEquityJob(jobId: string): Promise<unknown> {
    const env = await this.request("cancel_equity_job", { job_id: jobId });
    return env.body;
  }
}
