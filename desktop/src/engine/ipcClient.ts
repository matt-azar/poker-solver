/**
 * Tech-preview IPC client for `solver-engine`.
 * Domain ops mirror EngineClient; transport is framed pipes (not HTTP).
 * Default Study path remains HTTP `holdem-explorer` until cutover.
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

  constructor(
    private readonly write: IpcByteWriter,
    private readonly read: IpcByteReader,
  ) {}

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

  async node(nodeIndex = 0): Promise<unknown> {
    const env = await this.request("node", { node_index: nodeIndex });
    return env.body;
  }
}
