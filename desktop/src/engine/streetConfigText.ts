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
  appendFlag(lines, "allow-three-bet", (job.allow_three_bet ?? 1) !== 0);
  appendNumber(lines, "all-in-threshold", job.all_in_threshold ?? 0.5);
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

/**
 * Parse `street-config 1` text back into the loose solution-config object
 * `draftPartialFromSolutionConfig` / Apply template understand (ZR-92 / ZR-86).
 *
 * Always sets Apply-ready fields: `kind: "street"`, `tree_edits`, `incentives`,
 * and `edge_tags`. Throws on empty text or a missing `street-config 1` header.
 */
export function parseStreetConfigTextToSolutionConfig(
  text: string,
): Record<string, unknown> {
  if (!text.trim()) {
    throw new Error("invalid street-config: empty text");
  }

  const out: Record<string, unknown> = {
    kind: "street",
    street_config_text: text,
  };
  const treeEdits: string[] = [];
  const incentives: Array<{
    kind: "label" | "tag";
    player: number;
    key: string;
    delta: number;
  }> = [];
  const edgeTags: Array<{
    player?: number;
    action: string;
    tags: string[];
  }> = [];
  const sizeKeys: Record<string, string> = {
    "oop-bets": "oop_bets",
    "ip-bets": "ip_bets",
    "oop-raises": "oop_raises",
    "ip-raises": "ip_raises",
    "oop-flop-bets": "oop_flop_bets",
    "oop-turn-bets": "oop_turn_bets",
    "oop-river-bets": "oop_river_bets",
    "ip-flop-bets": "ip_flop_bets",
    "ip-turn-bets": "ip_turn_bets",
    "ip-river-bets": "ip_river_bets",
    "oop-flop-raises": "oop_flop_raises",
    "oop-turn-raises": "oop_turn_raises",
    "oop-river-raises": "oop_river_raises",
    "ip-flop-raises": "ip_flop_raises",
    "ip-turn-raises": "ip_turn_raises",
    "ip-river-raises": "ip_river_raises",
    "oop-donk": "oop_donk",
    "oop-flop-donk": "oop_flop_donk",
    "oop-turn-donk": "oop_turn_donk",
    "oop-river-donk": "oop_river_donk",
  };

  let sawHeader = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (!sawHeader) {
      if (line !== "street-config 1") {
        throw new Error("invalid street-config: expected street-config 1 header");
      }
      sawHeader = true;
      continue;
    }
    if (line.startsWith("street-config")) continue;
    const sp = line.indexOf(" ");
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? "" : line.slice(sp + 1).trim();
    switch (key) {
      case "board":
        out.board = value.split(/\s+/).filter(Boolean);
        break;
      case "pot":
      case "stack":
      case "max-raises":
      case "allow-three-bet":
      case "all-in-threshold":
      case "pot-cap":
      case "merge-threshold":
      case "rake-rate":
      case "rake-cap":
      case "memory-mib":
      case "threads":
      case "first-to-act":
        out[key.replace(/-/g, "_")] = Number(value);
        break;
      case "oop-range":
        out.oop_range = value;
        break;
      case "ip-range":
        out.ip_range = value;
        break;
      case "icm-stacks":
        out.icm_stacks = value
          .split(/[\s,]+/)
          .filter(Boolean)
          .map(Number);
        break;
      case "icm-payouts":
        out.icm_payouts = value
          .split(/[\s,]+/)
          .filter(Boolean)
          .map(Number);
        break;
      case "oop-raise-multiples":
      case "ip-raise-multiples":
        out[key.replace(/-/g, "_")] = value
          .split(/[\s,]+/)
          .filter(Boolean)
          .map(Number);
        break;
      case "incentive": {
        const tokens = value.split(/[\s,]+/).filter(Boolean);
        if (tokens.length !== 4) break;
        const kind = tokens[0];
        if (kind !== "label" && kind !== "tag") break;
        const player = Number(tokens[1]);
        const delta = Number(tokens[3]);
        if (!Number.isFinite(player) || !tokens[2] || !Number.isFinite(delta)) break;
        incentives.push({ kind, player, key: tokens[2], delta });
        break;
      }
      case "edge-tag": {
        const tokens = value.split(/[\s,]+/).filter(Boolean);
        if (tokens.length < 2) break;
        let player: number | undefined;
        let actionAt = 0;
        if ((tokens[0] === "0" || tokens[0] === "1") && tokens.length >= 3) {
          player = Number(tokens[0]);
          actionAt = 1;
        }
        const action = tokens[actionAt];
        const tags = tokens.slice(actionAt + 1);
        if (!action || tags.length === 0) break;
        edgeTags.push(player != null ? { player, action, tags } : { action, tags });
        break;
      }
      case "tree-edit":
        if (value) treeEdits.push(value);
        break;
      default: {
        const mapped = sizeKeys[key];
        if (mapped) {
          // Present even when blank so Build can rebuild check-only streets.
          out[mapped] = value.length === 0 ? [] : value.split(/\s+/).filter(Boolean);
        }
        break;
      }
    }
  }
  if (!sawHeader) {
    throw new Error("invalid street-config: expected street-config 1 header");
  }
  out.tree_edits = treeEdits;
  out.incentives = incentives;
  out.edge_tags = edgeTags;
  return out;
}
