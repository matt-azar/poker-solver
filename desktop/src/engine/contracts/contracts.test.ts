import { describe, expect, it } from "vitest";
import statusColdFixture from "../fixtures/status-cold.json";
import statusSolvedFixture from "../fixtures/status-solved.json";
import { decodeErrorPayload } from "./error";
import { decodeStatusPayload } from "./status";

describe("decodeStatusPayload", () => {
  it("accepts cold and solved fixtures and keeps additive fields", () => {
    const cold = decodeStatusPayload(statusColdFixture);
    expect(cold.running).toBe(false);
    expect(cold.status_generation).toBe(0);
    expect(cold.solution_id).toBeNull();
    expect(cold.phase).toBe("idle");
    expect(cold.iterations).toBe(0);
    expect(cold.iterations_requested).toBe(0);

    const solved = decodeStatusPayload(statusSolvedFixture);
    expect(solved.solution_id).toBe("s1");
    expect(solved.player0_expected_utility).toBe(50);
    expect(solved.future_additive_field).toBe("ignored");
    expect(solved.phase).toBe("published");
    expect(solved.iterations).toBe(2);
    expect(solved.iterations_requested).toBe(2);
    expect(solved.has_training).toBe(true);
    expect(solved.can_continue).toBe(true);
  });

  it("accepts compiling-shaped progress status (ZR-120)", () => {
    const compiling = decodeStatusPayload({
      running: true,
      paused: false,
      cancelled: false,
      failed: false,
      last_error: null,
      status_generation: 2,
      solution_id: "s1",
      job_id: null,
      root_node_id: "p0.t-1.r-1",
      phase: "compiling",
      iterations: 0,
      iterations_requested: 0,
      policy_revision: 0,
      has_training: true,
      can_continue: false,
      terminal_reason: "none",
    });
    expect(compiling.running).toBe(true);
    expect(compiling.phase).toBe("compiling");
    expect(compiling.iterations).toBe(0);
    expect(compiling.iterations_requested).toBe(0);
  });

  it("accepts sticky last_error string or null (ZR-130)", () => {
    const failed = decodeStatusPayload({
      running: false,
      paused: false,
      cancelled: false,
      failed: true,
      last_error: "InvalidSession",
      status_generation: 4,
    });
    expect(failed.last_error).toBe("InvalidSession");
    expect(failed.failed).toBe(true);

    const clear = decodeStatusPayload({
      running: false,
      paused: false,
      cancelled: false,
      failed: false,
      last_error: null,
      status_generation: 5,
    });
    expect(clear.last_error).toBeNull();
  });

  it("rejects wrong types for Zig progress fields when present", () => {
    expect(() =>
      decodeStatusPayload({
        running: false,
        paused: false,
        cancelled: false,
        status_generation: 0,
        iterations: "10",
      }),
    ).toThrow(/iterations/);
    expect(() =>
      decodeStatusPayload({
        running: false,
        paused: false,
        cancelled: false,
        status_generation: 0,
        phase: 1,
      }),
    ).toThrow(/phase/);
  });

  it("rejects can_continue without has_training (ZR-149)", () => {
    expect(() =>
      decodeStatusPayload({
        running: false,
        paused: true,
        cancelled: false,
        status_generation: 1,
        has_training: false,
        can_continue: true,
      }),
    ).toThrow(/can_continue requires has_training/);
  });

  it("rejects peak_allocated_bytes below allocated_bytes (ZR-149)", () => {
    expect(() =>
      decodeStatusPayload({
        running: false,
        paused: false,
        cancelled: false,
        status_generation: 1,
        allocated_bytes: 100,
        peak_allocated_bytes: 50,
      }),
    ).toThrow(/peak_allocated_bytes/);
  });

  it("rejects missing required flags", () => {
    expect(() =>
      decodeStatusPayload({
        paused: false,
        cancelled: false,
        status_generation: 0,
      }),
    ).toThrow(/running/);
  });
});

describe("decodeErrorPayload", () => {
  it("reads string error bodies", () => {
    expect(decodeErrorPayload({ error: "missing path" })).toBe("missing path");
    expect(decodeErrorPayload({ ok: false })).toBeNull();
  });
});
