import { describe, expect, it } from "vitest";
import { ALL_IN_SPEC } from "../domain/betSizes";
import { DEFAULT_SPOT } from "../domain/types";
import { buildJob } from "./studyDraft";

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
