import { describe, expect, it, vi } from "vitest";
import { AnalysisPageCache, AnalysisRequestQueue } from "./analysisCache";

describe("AnalysisPageCache", () => {
  it("stores and returns settled pages by identity", () => {
    const cache = new AnalysisPageCache(8);
    cache.set(
      { solutionId: "1", nodeId: "n0", revision: 2, kind: "values" },
      { pending: false, node_id: "n0", local_offset: 100 },
    );
    expect(
      cache.get({ solutionId: "1", nodeId: "n0", revision: 2, kind: "values" }),
    ).toEqual({ pending: false, node_id: "n0", local_offset: 100 });
    expect(
      cache.get({ solutionId: "1", nodeId: "n0", revision: 3, kind: "values" }),
    ).toBeUndefined();
  });

  it("refuses pending and error placeholders", () => {
    const cache = new AnalysisPageCache();
    cache.set(
      { solutionId: "1", nodeId: "n0", revision: 1, kind: "equity" },
      { pending: true, node_id: "n0" },
    );
    cache.set(
      { solutionId: "1", nodeId: "n0", revision: 1, kind: "equity" },
      { pending: false, error: "boom", node_id: "n0" },
    );
    expect(
      cache.get({ solutionId: "1", nodeId: "n0", revision: 1, kind: "equity" }),
    ).toBeUndefined();
  });

  it("clears one solution without touching others", () => {
    const cache = new AnalysisPageCache();
    cache.set(
      { solutionId: "1", nodeId: "a", revision: 1, kind: "values" },
      { ok: true },
    );
    cache.set(
      { solutionId: "2", nodeId: "a", revision: 1, kind: "values" },
      { ok: true },
    );
    cache.clearSolution("1");
    expect(
      cache.get({ solutionId: "1", nodeId: "a", revision: 1, kind: "values" }),
    ).toBeUndefined();
    expect(
      cache.get({ solutionId: "2", nodeId: "a", revision: 1, kind: "values" }),
    ).toEqual({ ok: true });
  });
});

describe("AnalysisRequestQueue", () => {
  it("runs jobs one at a time in priority order", async () => {
    const queue = new AnalysisRequestQueue();
    const order: string[] = [];
    let releasePrefetch!: () => void;
    const prefetchGate = new Promise<void>((resolve) => {
      releasePrefetch = resolve;
    });

    queue.enqueue({
      kind: "equity",
      solutionId: "1",
      nodeId: "a",
      revision: 1,
      priority: "prefetch",
      run: async () => {
        order.push("prefetch-start");
        await prefetchGate;
        order.push("prefetch-end");
      },
    });
    queue.enqueue({
      kind: "values",
      solutionId: "1",
      nodeId: "a",
      revision: 1,
      priority: "user",
      run: async () => {
        order.push("user");
      },
    });
    queue.enqueue({
      kind: "equity",
      solutionId: "1",
      nodeId: "b",
      revision: 1,
      priority: "auto",
      run: async () => {
        order.push("auto");
      },
    });

    // Prefetch already started before user was enqueued; user/auto wait.
    await vi.waitFor(() => expect(order).toContain("prefetch-start"));
    releasePrefetch();
    await queue.whenIdle();
    expect(order).toEqual(["prefetch-start", "prefetch-end", "user", "auto"]);
  });

  it("coalesces duplicate identities and upgrades priority", async () => {
    const queue = new AnalysisRequestQueue();
    const runs = vi.fn(async () => undefined);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    queue.enqueue({
      kind: "equity",
      solutionId: "1",
      nodeId: "a",
      revision: 1,
      priority: "prefetch",
      run: async () => {
        await gate;
      },
    });
    await vi.waitFor(() => expect(queue.busy).toBe(true));
    queue.enqueue({
      kind: "values",
      solutionId: "1",
      nodeId: "a",
      revision: 1,
      priority: "prefetch",
      run: runs,
    });
    queue.enqueue({
      kind: "values",
      solutionId: "1",
      nodeId: "a",
      revision: 1,
      priority: "user",
      run: runs,
    });
    release();
    await queue.whenIdle();
    expect(runs).toHaveBeenCalledTimes(1);
  });
});
