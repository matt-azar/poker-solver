import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXPLICIT_EMPTY_SPEC } from "../domain/betSizes";
import type { SolveJobRequest } from "../domain/types";
import {
  formatSolveJobStreetConfig,
  formatStreetConfigSpec,
  parseStreetConfigTextToSolutionConfig,
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
      allow_three_bet: 1,
      all_in_threshold: 0.5,
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

describe("parseStreetConfigTextToSolutionConfig", () => {
  it("sets Apply-ready kind + tree_edits and maps flop-check-down", () => {
    const text = readFileSync(
      resolve(repoRoot, "configs/templates/flop-check-down.txt"),
      "utf8",
    );
    const parsed = parseStreetConfigTextToSolutionConfig(text);
    expect(parsed.kind).toBe("street");
    expect(parsed.tree_edits).toEqual([]);
    expect(parsed.incentives).toEqual([]);
    expect(parsed.edge_tags).toEqual([]);
    expect(parsed.board).toEqual(["Ah", "Kd", "7c"]);
    expect(parsed.pot).toBe(100);
    expect(parsed.stack).toBe(100);
    expect(parsed.oop_range).toBe("AcAd:1");
    expect(parsed.ip_range).toBe("2c3d:1");
    expect(parsed.max_raises).toBe(0);
    expect(parsed.allow_three_bet).toBe(1);
    expect(parsed.all_in_threshold).toBe(0.5);
    expect(parsed.memory_mib).toBe(64);
    expect(parsed.threads).toBe(1);
    expect(parsed.street_config_text).toBe(text);
  });

  it("parses incentive / edge-tag / tree-edit lines", () => {
    const text = [
      "street-config 1",
      "board Ah Kd 7c",
      "pot 100",
      "stack 100",
      "oop-range AcAd:1",
      "ip-range 2c3d:1",
      "incentive label 0 Check 1.5",
      "incentive tag 1 flush 0.25",
      "edge-tag 0 Check value",
      "edge-tag Call bluff",
      "tree-edit force - c",
      "",
    ].join("\n");
    const parsed = parseStreetConfigTextToSolutionConfig(text);
    expect(parsed.kind).toBe("street");
    expect(parsed.incentives).toEqual([
      { kind: "label", player: 0, key: "Check", delta: 1.5 },
      { kind: "tag", player: 1, key: "flush", delta: 0.25 },
    ]);
    expect(parsed.edge_tags).toEqual([
      { player: 0, action: "Check", tags: ["value"] },
      { action: "Call", tags: ["bluff"] },
    ]);
    expect(parsed.tree_edits).toEqual(["force - c"]);
  });

  it("rejects empty and header-less text", () => {
    expect(() => parseStreetConfigTextToSolutionConfig("")).toThrow(/empty/i);
    expect(() => parseStreetConfigTextToSolutionConfig("board Ah Kd 7c\n")).toThrow(
      /street-config 1/i,
    );
  });
});
