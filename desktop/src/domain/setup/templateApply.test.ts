import { describe, expect, it } from "vitest";
import { DEFAULT_SPOT } from "../types";
import { buildJob } from "../../state/studyDraft";
import {
  draftFromFullTemplate,
  formatIncentivesDraft,
  formatEdgeTagsDraft,
} from "./templateApply";

describe("draftFromFullTemplate", () => {
  it("resets rake to 0 when loading a zero-rake template after a 5% draft", () => {
    const parsed = {
      kind: "street",
      board: ["Ah", "Kd", "7c"],
      pot: 100,
      stack: 100,
      oop_range: "AcAd:1",
      ip_range: "2c3d:1",
      max_raises: 0,
      allow_all_in: false,
      allow_three_bet: true,
      pot_cap: 0,
      all_in_threshold: 0,
      rake_rate: 0,
      rake_cap: 0,
      icm_stacks: [] as number[],
      icm_payouts: [] as number[],
      incentives: [] as unknown[],
      edge_tags: [] as unknown[],
      oop_bets: [] as number[],
      ip_bets: [] as number[],
      memory_mib: 64,
      threads: 1,
    };

    const next = draftFromFullTemplate(parsed, {
      solutionPath: "/good.psol",
      preserveSolveSession: {
        iterations: 50,
        algorithm: "cfr_plus",
        samples: 5,
        accuracy: "",
        frozen: true,
      },
    });

    // Prior draft had 5% rake — full template must not retain it.
    expect(next.rakeRate).toBe(0);
    expect(next.rakeCap).toBe(0);
    expect(next.solutionPath).toBe("/good.psol");
    expect(next.oopRange).toBe("AcAd:1");
    expect(next.useIcm).toBe(false);
    expect(next.incentives).toBe("");
    expect(next.timeLimit).toBe("");

    const job = buildJob(next);
    expect(job.rake_rate).toBe(0);
    expect(job.rake_cap).toBe(0);
  });

  it("preserves explicit non-zero rake from the parsed config", () => {
    const next = draftFromFullTemplate({
      kind: "street",
      board: ["Ah", "Kd", "7c"],
      pot: 100,
      stack: 100,
      rake_rate: 0.05,
      rake_cap: 3,
      oop_range: "AA",
      ip_range: "KK",
    });
    expect(next.rakeRate).toBe(0.05);
    expect(next.rakeCap).toBe(3);
  });

  it("resets absent utility fields even when parse omits them", () => {
    const next = draftFromFullTemplate(
      {
        kind: "street",
        board: ["Ah", "Kd", "7c"],
        pot: 100,
        stack: 100,
        oop_range: "AA",
        ip_range: "KK",
      },
      { solutionPath: "" },
    );
    expect(next.rakeRate).toBe(0);
    expect(next.rakeCap).toBe(0);
    expect(next.useIcm).toBe(false);
    expect(next.incentives).toBe("");
    expect(next.edgeTags).toBe("");
    expect(next.timeLimit).toBe("");
    expect(next.iterations).toBe(DEFAULT_SPOT.iterations);
  });
});

describe("incentive / edge-tag draft formatting", () => {
  it("formats incentives for Build text", () => {
    expect(
      formatIncentivesDraft([
        { kind: "label", player: 0, key: "c", delta: 1.5 },
        { kind: "tag", player: 1, key: "slowplay", delta: -0.25 },
      ]),
    ).toBe("label 0 c 1.5; tag 1 slowplay -0.25");
  });

  it("formats edge tags for Build text", () => {
    expect(
      formatEdgeTagsDraft([
        { player: 0, action: "c", tags: ["slowplay"] },
        { action: "b100", tags: ["value", "bluff"] },
      ]),
    ).toBe("0 c slowplay; b100 value bluff");
  });
});
