import { describe, expect, it } from "vitest";
import { ALL_IN_SPEC } from "../domain/betSizes";
import { DEFAULT_SPOT } from "../domain/types";
import { buildJob, phaseFromStatus } from "./studyDraft";

describe("phaseFromStatus", () => {
  it("maps host phase=failed and clears sticky stop_requested when idle", () => {
    expect(
      phaseFromStatus(
        {
          running: false,
          paused: false,
          cancelled: false,
          status_generation: 1,
          phase: "failed",
        },
        "solving",
      ),
    ).toBe("failed");
    expect(
      phaseFromStatus(
        {
          running: false,
          paused: false,
          cancelled: false,
          status_generation: 2,
          phase: "idle",
        },
        "stop_requested",
      ),
    ).toBe("idle");
  });

  it("maps sticky last_error to failed even when phase stayed published (ZR-130)", () => {
    expect(
      phaseFromStatus(
        {
          running: false,
          paused: false,
          cancelled: false,
          failed: true,
          last_error: "InvalidSession",
          status_generation: 3,
          phase: "published",
        },
        "solving",
      ),
    ).toBe("failed");
  });

  it("maps host compiling to Building (ZR-120)", () => {
    expect(
      phaseFromStatus(
        {
          running: true,
          paused: false,
          cancelled: false,
          phase: "compiling",
          status_generation: 1,
        },
        "idle",
      ),
    ).toBe("building");
  });

  it("maps running train status to Solving with iteration fields intact", () => {
    const status = {
      running: true,
      paused: false,
      cancelled: false,
      phase: "training",
      iterations: 12,
      iterations_requested: 200,
      status_generation: 2,
    };
    expect(phaseFromStatus(status, "building")).toBe("solving");
    expect(status.iterations).toBe(12);
    expect(status.iterations_requested).toBe(200);
  });

  it("preserves pause_requested / stop_requested while host is still running (ZR-148)", () => {
    const running = {
      running: true,
      paused: false,
      cancelled: false,
      phase: "training",
      status_generation: 4,
    };
    expect(phaseFromStatus(running, "pause_requested")).toBe("pause_requested");
    expect(phaseFromStatus(running, "stop_requested")).toBe("stop_requested");
    expect(phaseFromStatus(running, "solving")).toBe("solving");
  });

  it("maps failed flag with empty error string to Failed", () => {
    expect(
      phaseFromStatus(
        {
          running: false,
          paused: false,
          cancelled: false,
          failed: true,
          error: "",
          phase: "failed",
          status_generation: 5,
        },
        "solving",
      ),
    ).toBe("failed");
  });
});

describe("buildJob allow_all_in", () => {
  it("sends allow_all_in: 0 for Build sizes without a", () => {
    const job = buildJob({
      ...DEFAULT_SPOT,
      boardText: "Ah Kd 7c",
      oopFlop: "50",
      ipFlop: "50",
      oopTurn: "50",
      ipTurn: "50",
      oopRiver: "50",
      ipRiver: "50",
      allowAllIn: true, // draft flag must not invent engine all-in
    });
    expect(job.allow_all_in).toBe(0);
    expect(job.oop_flop_bets).toEqual([0.5]);
    expect(job.oop_flop_bets).not.toContain(ALL_IN_SPEC);
  });

  it("still encodes the a sentinel in size lists when listed", () => {
    const job = buildJob({
      ...DEFAULT_SPOT,
      boardText: "Ah Kd 7c",
      oopFlop: "50, a",
      ipFlop: "50",
      oopTurn: "",
      ipTurn: "",
      oopRiver: "a",
      ipRiver: "50, a",
    });
    expect(job.allow_all_in).toBe(0);
    expect(job.oop_flop_bets).toEqual([0.5, ALL_IN_SPEC]);
    expect(job.oop_river_bets).toEqual([ALL_IN_SPEC]);
    expect(job.ip_river_bets).toEqual([0.5, ALL_IN_SPEC]);
  });
});
