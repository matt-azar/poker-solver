/**
 * Serialize a Study SolveJobRequest to `street-config 1` text for solver-engine
 * `begin_config`. Size tokens match C++/Zig `format_spec` (pot fractions, not
 * Build UI percentages).
 */
import {
  isAllInSpec,
  isExplicitEmptyList,
  isExplicitEmptySpec,
  isGeometricSpec,
  isMultipleSpec,
} from "../domain/betSizes";
import type { SolveJobRequest } from "../domain/types";

const GEO_BASE = -2e9;
const MULTIPLE_BASE = -3e9;

function trimNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  // Prefer shortest round-trip similar to std::chars_format::general.
  const text = String(value);
  if (!text.includes("e") && !text.includes("E")) {
    return text;
  }
  return value.toPrecision(15).replace(/\.?0+$/, "");
}

/** One size-list token for street-config (space-separated lists). */
export function formatStreetConfigSpec(spec: number): string {
  if (isExplicitEmptySpec(spec)) {
    return "-";
  }
  if (isAllInSpec(spec)) {
    return "a";
  }
  if (isGeometricSpec(spec)) {
    const streets = Math.round(-(spec - GEO_BASE));
    return streets <= 0 ? "e" : `${streets}e`;
  }
  if (isMultipleSpec(spec)) {
    return `${trimNumber(-(spec - MULTIPLE_BASE))}x`;
  }
  if (spec < 0 && spec > -1e8) {
    return `${trimNumber(-spec)}c`;
  }
  return trimNumber(spec);
}

function appendLine(lines: string[], key: string, value: string): void {
  lines.push(value === "" ? key : `${key} ${value}`);
}

function appendFlag(lines: string[], key: string, value: boolean): void {
  appendLine(lines, key, value ? "1" : "0");
}

function appendNumber(lines: string[], key: string, value: number): void {
  appendLine(lines, key, trimNumber(value));
}

function appendInt(lines: string[], key: string, value: number): void {
  appendLine(lines, key, String(Math.trunc(value)));
}

function appendSpecs(lines: string[], key: string, specs: number[] | undefined): void {
  if (!specs || specs.length === 0) {
    return;
  }
  if (isExplicitEmptyList(specs)) {
    appendLine(lines, key, "-");
    return;
  }
  appendLine(lines, key, specs.map(formatStreetConfigSpec).join(" "));
}

function appendNumbers(lines: string[], key: string, values: number[] | undefined): void {
  if (!values || values.length === 0) {
    return;
  }
  appendLine(lines, key, values.map(trimNumber).join(" "));
}

/**
 * Build a `street-config 1` document from a Study solve job.
 * Iterations / algorithm / frozen stay off the document (host solve args / CFR+).
 */
export function formatSolveJobStreetConfig(job: SolveJobRequest): string {
  if (!Array.isArray(job.board) || job.board.length < 3 || job.board.length > 5) {
    throw new Error("street-config board must contain 3, 4, or 5 cards");
  }
  const lines: string[] = ["street-config 1"];
  appendLine(lines, "board", job.board.join(" "));
  appendNumber(lines, "pot", job.pot);
  appendNumber(lines, "stack", job.stack);
  appendLine(lines, "oop-range", job.oop_range);
  appendLine(lines, "ip-range", job.ip_range);
  appendInt(lines, "first-to-act", 0);
  appendInt(lines, "max-raises", job.max_raises ?? 2);
  appendFlag(lines, "allow-all-in", (job.allow_all_in ?? 1) !== 0);
  appendFlag(lines, "allow-three-bet", (job.allow_three_bet ?? 1) !== 0);
  appendNumber(lines, "all-in-threshold", job.all_in_threshold ?? 0);
  appendNumber(lines, "pot-cap", job.pot_cap ?? 0);
  if ((job.merge_threshold ?? 0) !== 0) {
    appendNumber(lines, "merge-threshold", job.merge_threshold ?? 0);
  }
  appendNumber(lines, "rake-rate", job.rake_rate ?? 0);
  appendNumber(lines, "rake-cap", job.rake_cap ?? 0);
  appendNumbers(lines, "icm-stacks", job.icm_stacks);
  appendNumbers(lines, "icm-payouts", job.icm_payouts);
  for (const rule of job.incentives ?? []) {
    appendLine(
      lines,
      "incentive",
      `${rule.kind} ${rule.player} ${rule.key} ${trimNumber(rule.delta)}`,
    );
  }
  for (const edge of job.edge_tags ?? []) {
    const playerPrefix =
      edge.player != null && edge.player >= 0 ? `${edge.player} ` : "";
    appendLine(
      lines,
      "edge-tag",
      `${playerPrefix}${edge.action}${(edge.tags ?? []).map((t) => ` ${t}`).join("")}`,
    );
  }
  appendInt(lines, "memory-mib", job.memory_mib ?? 1024);
  appendInt(lines, "threads", job.threads ?? 1);
  appendSpecs(lines, "oop-bets", job.oop_bets);
  appendSpecs(lines, "ip-bets", job.ip_bets);
  appendSpecs(lines, "oop-raises", job.oop_raises);
  appendSpecs(lines, "ip-raises", job.ip_raises);
  appendSpecs(lines, "oop-flop-bets", job.oop_flop_bets);
  appendSpecs(lines, "oop-turn-bets", job.oop_turn_bets);
  appendSpecs(lines, "oop-river-bets", job.oop_river_bets);
  appendSpecs(lines, "ip-flop-bets", job.ip_flop_bets);
  appendSpecs(lines, "ip-turn-bets", job.ip_turn_bets);
  appendSpecs(lines, "ip-river-bets", job.ip_river_bets);
  appendSpecs(lines, "oop-flop-raises", job.oop_flop_raises);
  appendSpecs(lines, "oop-turn-raises", job.oop_turn_raises);
  appendSpecs(lines, "oop-river-raises", job.oop_river_raises);
  appendSpecs(lines, "ip-flop-raises", job.ip_flop_raises);
  appendSpecs(lines, "ip-turn-raises", job.ip_turn_raises);
  appendSpecs(lines, "ip-river-raises", job.ip_river_raises);
  appendSpecs(lines, "oop-donk", job.oop_donk);
  appendSpecs(lines, "oop-flop-donk", job.oop_flop_donk);
  appendSpecs(lines, "oop-turn-donk", job.oop_turn_donk);
  appendSpecs(lines, "oop-river-donk", job.oop_river_donk);
  appendNumbers(lines, "oop-raise-multiples", job.oop_raise_multiples);
  appendNumbers(lines, "ip-raise-multiples", job.ip_raise_multiples);
  for (const edit of job.tree_edits ?? []) {
    const line = edit.trim();
    if (line) {
      appendLine(lines, "tree-edit", line);
    }
  }
  return `${lines.join("\n")}\n`;
}
