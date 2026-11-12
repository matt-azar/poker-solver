import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXPLICIT_EMPTY_SPEC } from "../domain/betSizes";
import type { SolveJobRequest } from "../domain/types";
import {
  formatSolveJobStreetConfig,
  formatStreetConfigSpec,
} from "./streetConfigText";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

describe("formatStreetConfigSpec", () => {
  it("matches street-config pot-fraction / sentinel spelling", () => {
    expect(formatStreetConfigSpec(0.5)).toBe("0.5");
    expect(formatStreetConfigSpec(1)).toBe("1");
    expect(formatStreetConfigSpec(EXPLICIT_EMPTY_SPEC)).toBe("-");
    expect(formatStreetConfigSpec(-1e9)).toBe("a");
    expect(formatStreetConfigSpec(-20)).toBe("20c");
  });
});

describe("formatSolveJobStreetConfig", () => {
  it("emits a parseable river smoke document", () => {
    const job: SolveJobRequest = {
      board: ["Ah", "Kh", "Qh", "Jh", "2c"],
      oop_range: "AsQs:1,2d2h:1",
      ip_range: "AsQs:1,2d2h:1",
      pot: 100,
      stack: 100,
      oop_bets: [],
      ip_bets: [],
      oop_river_bets: [1],
      ip_river_bets: [1],
      max_raises: 0,
      allow_all_in: 1,
      allow_three_bet: 1,
      iterations: 1,
      memory_mib: 256,
      threads: 1,
    };
    const text = formatSolveJobStreetConfig(job);
    expect(text.startsWith("street-config 1\n")).toBe(true);
    expect(text).toContain("board Ah Kh Qh Jh 2c\n");
    expect(text).toContain("oop-river-bets 1\n");
    expect(text).toContain("ip-river-bets 1\n");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("round-trips locked flop_srp_one_size scalars from the fixture header", () => {
    const fixture = readFileSync(
      resolve(repoRoot, "benchmarks/study/configs/flop_srp_one_size.txt"),
      "utf8",
    );
    const job: SolveJobRequest = {
      board: ["Js", "8h", "3h"],
      oop_range: "AA",
      ip_range: "KK",
      pot: 100,
      stack: 500,
      oop_bets: [0.5],
      ip_bets: [0.5],
      oop_raises: [0.75],
      ip_raises: [0.75],
      max_raises: 2,
      allow_all_in: 1,
      allow_three_bet: 1,
      all_in_threshold: 0,
      pot_cap: 0,
      rake_rate: 0,
      rake_cap: 0,
      memory_mib: 4096,
      threads: 1,
      iterations: 1,
    };
    const text = formatSolveJobStreetConfig(job);
    expect(text).toContain("board Js 8h 3h\n");
    expect(text).toContain("pot 100\n");
    expect(text).toContain("stack 500\n");
    expect(text).toContain("oop-bets 0.5\n");
    expect(text).toContain("ip-raises 0.75\n");
    expect(fixture).toContain("board Js 8h 3h");
  });
});
