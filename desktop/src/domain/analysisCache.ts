/**
 * Client-side analysis page cache + serialized ValueWorker queue.
 *
 * Explorer runs one ValueWorker: a new equity/values/runouts submit cancels the
 * in-flight walk. Study used to fire overlapping polls (matrix overlay, Bluffs,
 * Hands, manual Calculate) which cancelled each other forever. This module:
 *   1. Remembers ready pages by solution/node/revision/kind so navigation is free.
 *   2. Runs worker-bound kinds one at a time (user jobs before prefetch).
 * Full-tree frontload after solve is intentionally not done — large trees make
 * that too expensive; we warm the live node and optionally its children.
 */

export type WorkerAnalysisKind = "values" | "equity" | "runouts";

export type AnalysisCacheKey = {
  solutionId: string;
  nodeId: string;
  revision: number;
  kind: WorkerAnalysisKind | "categories";
};

export type AnalysisPriority = "user" | "auto" | "prefetch";

export type QueuedAnalysisJob = {
  id: number;
  kind: WorkerAnalysisKind;
  solutionId: string;
  nodeId: string;
  revision: number;
  priority: AnalysisPriority;
  /** Run the actual fetch/poll; must resolve when the page is ready or failed. */
  run: () => Promise<void>;
};

const PRIORITY_RANK: Record<AnalysisPriority, number> = {
  user: 0,
  auto: 1,
  prefetch: 2,
};

export function analysisCacheKey(parts: AnalysisCacheKey): string {
  return `${parts.solutionId}\0${parts.nodeId}\0${parts.revision}\0${parts.kind}`;
}

export class AnalysisPageCache {
  private readonly pages = new Map<string, unknown>();
  private readonly order: string[] = [];
  private readonly cap: number;

  constructor(cap = 64) {
    this.cap = Math.max(8, cap);
  }

  get<T>(parts: AnalysisCacheKey): T | undefined {
    const key = analysisCacheKey(parts);
    if (!this.pages.has(key)) {
      return undefined;
    }
    // LRU touch.
    const at = this.order.indexOf(key);
    if (at >= 0) {
      this.order.splice(at, 1);
      this.order.push(key);
    }
    return this.pages.get(key) as T;
  }

  set(parts: AnalysisCacheKey, page: unknown): void {
    if (page == null) {
      return;
    }
    // Never cache pending/error placeholders — only settled successful bodies.
    const record = page as { pending?: boolean; error?: string };
    if (record.pending || record.error) {
      return;
    }
    const key = analysisCacheKey(parts);
    if (this.pages.has(key)) {
      const at = this.order.indexOf(key);
      if (at >= 0) {
        this.order.splice(at, 1);
      }
    }
    this.pages.set(key, page);
    this.order.push(key);
    while (this.order.length > this.cap) {
      const oldest = this.order.shift();
      if (oldest) {
        this.pages.delete(oldest);
      }
    }
  }

  clearSolution(solutionId: string): void {
    const prefix = `${solutionId}\0`;
    for (const key of [...this.pages.keys()]) {
      if (key.startsWith(prefix)) {
        this.pages.delete(key);
      }
    }
    for (let i = this.order.length - 1; i >= 0; i -= 1) {
      if (this.order[i]!.startsWith(prefix)) {
        this.order.splice(i, 1);
      }
    }
  }

  clear(): void {
    this.pages.clear();
    this.order.length = 0;
  }

  size(): number {
    return this.pages.size;
  }
}

/**
 * Single-flight queue for ValueWorker-bound analysis. Coalesces duplicate
 * identities; higher priority (user > auto > prefetch) wins when replacing.
 */
export class AnalysisRequestQueue {
  private queue: QueuedAnalysisJob[] = [];
  private running: QueuedAnalysisJob | null = null;
  private nextId = 1;
  private drained: Promise<void> = Promise.resolve();
  private resolveDrained: (() => void) | null = null;

  enqueue(job: Omit<QueuedAnalysisJob, "id">): number {
    const identity = (entry: QueuedAnalysisJob) =>
      entry.kind === job.kind &&
      entry.solutionId === job.solutionId &&
      entry.nodeId === job.nodeId &&
      entry.revision === job.revision;

    if (this.running && identity(this.running)) {
      // Already in flight for this page — callers share the poll via tokens.
      return this.running.id;
    }

    const existing = this.queue.findIndex(identity);
    if (existing >= 0) {
      const prior = this.queue[existing]!;
      if (PRIORITY_RANK[job.priority] < PRIORITY_RANK[prior.priority]) {
        this.queue[existing] = { ...job, id: prior.id };
      }
      return this.queue[existing]!.id;
    }

    const id = this.nextId++;
    this.queue.push({ ...job, id });
    this.queue.sort(
      (left, right) => PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority],
    );
    void this.pump();
    return id;
  }

  /** Drop queued prefetch/auto work (e.g. on navigate). In-flight keeps going
   * until its token check abandons; optional kinds filter. */
  cancelQueued(predicate?: (job: QueuedAnalysisJob) => boolean): void {
    if (!predicate) {
      this.queue = [];
      return;
    }
    this.queue = this.queue.filter((job) => !predicate(job));
  }

  /** True while a worker-bound job is executing. */
  get busy(): boolean {
    return this.running != null;
  }

  /** Resolves when the queue is idle (no running job, no pending). */
  whenIdle(): Promise<void> {
    if (!this.running && this.queue.length === 0) {
      return Promise.resolve();
    }
    return this.drained;
  }

  private ensureDrainPromise(): void {
    if (this.resolveDrained) {
      return;
    }
    this.drained = new Promise((resolve) => {
      this.resolveDrained = resolve;
    });
  }

  private finishDrain(): void {
    const resolve = this.resolveDrained;
    this.resolveDrained = null;
    resolve?.();
  }

  private async pump(): Promise<void> {
    if (this.running) {
      return;
    }
    const next = this.queue.shift();
    if (!next) {
      this.finishDrain();
      return;
    }
    this.ensureDrainPromise();
    this.running = next;
    try {
      await next.run();
    } catch {
      // run() reports errors to the store; never break the queue.
    } finally {
      this.running = null;
      void this.pump();
    }
  }
}
