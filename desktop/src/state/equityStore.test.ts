import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ensureEngine = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true as const,
    status: "solver-engine IPC (protocol 2)",
    transport: { kind: "ipc" as const, label: "test", protocol: 2, launchId: "t", sidecar: "solver-engine", workers: 1 },
  })),
);

vi.mock("../platform/engine", () => ({
  ensureEngine: (...args: unknown[]) => ensureEngine(...args),
}));

import { EngineClient, engineClient } from "../engine/client";
import {
  clearFixtureIpcHandlerForTests,
  installFixtureIpcHandler,
  setIpcTransport,
  setNoEngineTransport,
  type IpcRequestEnvelope,
} from "../engine/transport";
import { useEquityStore } from "./equityStore";

function ok(op: string, body: unknown, requestId = "t"): IpcRequestEnvelope {
  return {
    v: 2,
    kind: "reply",
    request_id: requestId,
    job_id: null,
    op,
    ok: true,
    error_code: null,
    error_message: null,
    body,
  };
}

function fail(op: string, code: string, message: string): IpcRequestEnvelope {
  return {
    v: 2,
    kind: "reply",
    request_id: "t",
    job_id: null,
    op,
    ok: false,
    error_code: code,
    error_message: message,
    body: null,
  };
}

describe("equityStore calculate (ZR-84 IPC product path)", () => {
  beforeEach(() => {
    ensureEngine.mockClear();
    ensureEngine.mockResolvedValue({
      ok: true,
      status: "solver-engine IPC (protocol 2)",
      transport: {
        kind: "ipc",
        label: "test",
        protocol: 2,
        launchId: "t",
        sidecar: "solver-engine",
        workers: 1,
      },
    });
    setIpcTransport({ protocol: 2, launchId: "t", sidecar: "solver-engine", workers: 1 });
    clearFixtureIpcHandlerForTests();
    useEquityStore.setState({
      draft: {
        version: 1,
        name: "test",
        players: [
          { id: "p1", label: "Player 1", enabled: true, rangeText: "AsAd" },
          { id: "p2", label: "Player 2", enabled: true, rangeText: "KcKd" },
        ],
        board: ["2c", "3d", "7h", "9s", "Jc"],
        deadCards: [],
        method: "exact",
        targetSamples: 1000,
        seed: 1,
        selectedPlayerId: "p1",
      },
      recent: [],
      run: {
        jobId: null,
        revision: "",
        status: null,
        starting: false,
        stale: false,
        error: null,
        previous: null,
      },
    });
  });

  afterEach(() => {
    clearFixtureIpcHandlerForTests();
    setNoEngineTransport();
    vi.useRealTimers();
  });

  it("ensures the engine, starts a job, and paints completed equity", async () => {
    vi.useFakeTimers();
    let polls = 0;
    installFixtureIpcHandler(async (op, body) => {
      if (op === "start_equity_job") {
        expect(body).toMatchObject({
          method: "exact",
          board: ["2c", "3d", "7h", "9s", "Jc"],
          players: [
            { id: "p1", range: "AsAd" },
            { id: "p2", range: "KcKd" },
          ],
        });
        return ok(op, { job_id: "eq1", state: "queued" });
      }
      if (op === "get_equity_job") {
        polls += 1;
        expect(body).toEqual({ job_id: "eq1" });
        if (polls < 2) {
          return ok(op, {
            job_id: "eq1",
            state: "running",
            client_revision: "r",
            progress_done: 0,
            progress_total: 1,
            elapsed_seconds: 0,
          });
        }
        return ok(op, {
          job_id: "eq1",
          state: "completed",
          client_revision: "r",
          progress_done: 1,
          progress_total: 1,
          elapsed_seconds: 0.01,
          result: {
            model: "check-down",
            units: "fraction of the pot",
            method_version: "equity-calc-1",
            requested_method: "exact",
            actual_method: "exact",
            method_reason: "exact requested",
            joint_defined: true,
            exact_complete: true,
            stopped: false,
            legal_tuples: 1,
            completions_per_tuple: 1,
            exact_deals: 1,
            accepted_samples: 0,
            attempted_tuples: 0,
            seed: 1,
            elapsed_seconds: 0.01,
            board: ["2c", "3d", "7h", "9s", "Jc"],
            dead_cards: [],
            players: [
              { id: "p1", defined: true, equity: 1, win: 1, tie: 0, loss: 0 },
              { id: "p2", defined: true, equity: 0, win: 0, tie: 0, loss: 1 },
            ],
          },
        });
      }
      return fail(op, "unexpected", op);
    });

    // calculate() admits the job and returns; completion arrives via poll interval.
    await useEquityStore.getState().calculate();
    expect(ensureEngine).toHaveBeenCalled();
    expect(useEquityStore.getState().run.jobId).toBe("eq1");

    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(250);
      if (useEquityStore.getState().run.status?.state === "completed") {
        break;
      }
    }

    const run = useEquityStore.getState().run;
    expect(run.starting).toBe(false);
    expect(run.jobId).toBe("eq1");
    expect(run.status?.state).toBe("completed");
    expect(run.status?.result?.players[0]?.equity).toBe(1);
    expect(run.error).toBeNull();
  });

  it("surfaces ensureEngine failure instead of empty-HTTP fallthrough", async () => {
    ensureEngine.mockResolvedValueOnce({
      ok: false,
      status: "solver-engine unavailable",
      error: "sidecar spawn failed",
      transport: { kind: "no-engine", label: "no engine" },
    });

    await useEquityStore.getState().calculate();

    const run = useEquityStore.getState().run;
    expect(run.starting).toBe(false);
    expect(run.jobId).toBeNull();
    expect(run.error).toMatch(/sidecar spawn failed/i);
  });

  it("fails when start_equity_job returns no job_id (demo/fixture trap)", async () => {
    installFixtureIpcHandler(async (op) => {
      if (op === "start_equity_job") {
        return ok(op, {});
      }
      return fail(op, "unexpected", op);
    });

    await useEquityStore.getState().calculate();

    const run = useEquityStore.getState().run;
    expect(run.starting).toBe(false);
    expect(run.jobId).toBeNull();
    expect(run.error).toMatch(/no job_id/i);
  });
});

describe("EngineClient equity job id validation", () => {
  it("rejects empty job ids on get/cancel", async () => {
    setIpcTransport({ protocol: 2, launchId: "t", sidecar: "solver-engine", workers: 1 });
    const client = new EngineClient({ baseUrl: "http://unused" });
    await expect(client.getEquityJob("")).rejects.toMatchObject({
      name: "EngineError",
      message: expect.stringMatching(/job id required/i),
    });
    await expect(client.cancelEquityJob("  ")).rejects.toMatchObject({
      name: "EngineError",
      message: expect.stringMatching(/job id required/i),
    });
    void engineClient;
  });
});
