/**
 * hand-history 1 → reviewable river holdem-study-job/1.
 * Supported street boundary: five-card board only (river).
 */
import { formatSolveJobStreetConfig } from "../../engine/streetConfigText";
import type { SolveJobRequest, TreePreviewNode } from "../types";
import {
  decisionActionsForStudy,
  heuristicDecisionActions,
} from "./decisionPath";
import {
  STUDY_JOB_SCHEMA,
  type StudyJob,
  type StudyJobReview,
} from "./types";

export interface HandHistoryAction {
  player: 0 | 1;
  label: string;
}

export interface HandHistoryRecord {
  board: string[];
  pot: number;
  stack: number;
  oopHole?: string;
  ipHole?: string;
  oopLabel?: string;
  ipLabel?: string;
  actions: HandHistoryAction[];
  terminalPot: number;
  outcome: "showdown" | "fold";
  p0Net: number;
}

export interface RiverJobFromHandHistoryOptions {
  /** Explicit pot-fraction bet lists; default includes played sizes + 0.5. */
  oopRiverBets?: number[];
  ipRiverBets?: number[];
  iterations?: number;
  accuracy?: number | null;
  time_limit?: number | null;
  memoryMib?: number;
  threads?: number;
  positions?: { oop?: string; ip?: string };
  /** Actions to open Study at; default = path to last decision (not terminal). */
  decisionActions?: string[];
  /** When provided, validate the line against this compiled preview tree. */
  previewNodes?: TreePreviewNode[];
  created_at?: string;
}

function trimNumber(value: number): string {
  const text = String(value);
  if (!text.includes("e") && !text.includes("E")) return text;
  return value.toPrecision(15).replace(/\.?0+$/, "");
}

function parseFinite(text: string): number {
  const n = Number(text);
  if (!Number.isFinite(n)) {
    throw new Error(`bad number in hand history: ${text}`);
  }
  return n;
}

function parseIntStrict(text: string): number {
  const n = parseFinite(text);
  if (n !== Math.trunc(n)) {
    throw new Error(`bad integer in hand history: ${text}`);
  }
  return Math.trunc(n);
}

/** Parse a `hand-history 1` document. */
export function parseHandHistory(text: string): HandHistoryRecord {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0 || lines[0].trim() !== "hand-history 1") {
    throw new Error("invalid hand-history: expected hand-history 1 header");
  }

  let board: string[] | null = null;
  let pot: number | null = null;
  let stack: number | null = null;
  let oopHole: string | undefined;
  let ipHole: string | undefined;
  let oopLabel: string | undefined;
  let ipLabel: string | undefined;
  const actions: HandHistoryAction[] = [];
  let terminalPot: number | null = null;
  let outcome: "showdown" | "fold" | null = null;
  let p0Net: number | null = null;

  for (let i = 1; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith("#")) continue;
    const sp = raw.indexOf(" ");
    const key = sp < 0 ? raw : raw.slice(0, sp);
    const value = sp < 0 ? "" : raw.slice(sp + 1).trim();
    switch (key) {
      case "board":
        board = value.split(/\s+/).filter(Boolean);
        break;
      case "pot":
        pot = parseFinite(value);
        break;
      case "stack":
        stack = parseFinite(value);
        break;
      case "oop-hole":
        oopHole = value;
        break;
      case "ip-hole":
        ipHole = value;
        break;
      case "oop-label":
        oopLabel = value;
        break;
      case "ip-label":
        ipLabel = value;
        break;
      case "action": {
        const tokens = value.split(/\s+/).filter(Boolean);
        if (tokens.length < 2) {
          throw new Error(`bad action line: ${raw}`);
        }
        const player = parseIntStrict(tokens[0]);
        if (player !== 0 && player !== 1) {
          throw new Error(`action player must be 0 or 1: ${raw}`);
        }
        actions.push({ player, label: tokens.slice(1).join(" ") });
        break;
      }
      case "terminal-pot":
        terminalPot = parseFinite(value);
        break;
      case "outcome":
        if (value !== "showdown" && value !== "fold") {
          throw new Error(`outcome must be showdown or fold: ${value}`);
        }
        outcome = value;
        break;
      case "p0-net":
        p0Net = parseFinite(value);
        break;
      default:
        throw new Error(`unknown hand-history field: ${key}`);
    }
  }

  if (!board || board.length === 0) throw new Error("hand-history missing board");
  if (pot == null) throw new Error("hand-history missing pot");
  if (stack == null) throw new Error("hand-history missing stack");
  if (terminalPot == null) throw new Error("hand-history missing terminal-pot");
  if (outcome == null) throw new Error("hand-history missing outcome");
  if (p0Net == null) throw new Error("hand-history missing p0-net");

  return {
    board,
    pot,
    stack,
    oopHole,
    ipHole,
    oopLabel,
    ipLabel,
    actions,
    terminalPot,
    outcome,
    p0Net,
  };
}

function rangeFromRecord(seat: "oop" | "ip", record: HandHistoryRecord): {
  range: string;
  source: string;
} {
  const hole = seat === "oop" ? record.oopHole : record.ipHole;
  const label = seat === "oop" ? record.oopLabel : record.ipLabel;
  if (hole && hole.trim()) {
    return { range: `${hole.trim()}:1`, source: `${seat}-hole ${hole.trim()}` };
  }
  if (label && label.trim()) {
    // Labels may already be weighted range text.
    const text = label.trim();
    return { range: text, source: `${seat}-label ${text.slice(0, 48)}` };
  }
  throw new Error(
    `hand-history needs ${seat}-hole or ${seat}-label to propose a range source`,
  );
}

/** Extract Bet/Raise chip amounts from canonical labels. */
export function sizedActionChips(label: string): { kind: "bet" | "raise"; chips: number } | null {
  let core = label.trim();
  if (core.endsWith(" all-in")) {
    core = core.slice(0, -" all-in".length);
  }
  if (core.startsWith("Bet ")) {
    const chips = Number(core.slice(4));
    if (!Number.isFinite(chips) || chips <= 0) return null;
    return { kind: "bet", chips };
  }
  if (core.startsWith("Raise to ")) {
    const chips = Number(core.slice("Raise to ".length));
    if (!Number.isFinite(chips) || chips <= 0) return null;
    return { kind: "raise", chips };
  }
  return null;
}

/**
 * Pot-fraction size implied by a Bet N label at street-start pot.
 * Raise-to uses (raise_to - prior_facing) / pot approximation at root pot —
 * for river HH from street start with no prior contrib, Bet N → N/pot.
 */
export function potFractionForPlayedSize(label: string, pot: number): number | null {
  if (!(pot > 0)) return null;
  const sized = sizedActionChips(label);
  if (!sized) return null;
  if (sized.kind === "bet") {
    return sized.chips / pot;
  }
  // Raise to N from check-facing is unusual at root; treat as N/pot for tree match.
  return sized.chips / pot;
}

function uniqueFractions(values: number[]): number[] {
  const out: number[] = [];
  for (const v of values) {
    if (!Number.isFinite(v) || v <= 0) continue;
    if (out.some((x) => Math.abs(x - v) < 1e-9)) continue;
    out.push(v);
  }
  return out.sort((a, b) => a - b);
}

function approxInList(target: number, list: number[]): boolean {
  return list.some((x) => Math.abs(x - target) < 1e-6);
}

/**
 * Build a reviewable river job from a parsed HU hand history.
 * Flags played sizes missing from the configured bet arrays.
 */
export function riverJobFromHandHistory(
  record: HandHistoryRecord,
  options: RiverJobFromHandHistoryOptions = {},
): StudyJob {
  if (record.board.length !== 5) {
    throw new Error(
      `river job requires a 5-card board (got ${record.board.length}); other streets are unsupported`,
    );
  }

  const oop = rangeFromRecord("oop", record);
  const ip = rangeFromRecord("ip", record);
  const action_line = record.actions.map((a) => a.label);

  const playedFractions: number[] = [];
  for (const label of action_line) {
    const frac = potFractionForPlayedSize(label, record.pot);
    if (frac != null) playedFractions.push(frac);
  }

  const defaultBets = uniqueFractions([0.5, ...playedFractions]);
  const oopRiverBets = options.oopRiverBets?.length
    ? uniqueFractions(options.oopRiverBets)
    : defaultBets;
  const ipRiverBets = options.ipRiverBets?.length
    ? uniqueFractions(options.ipRiverBets)
    : defaultBets;

  // Fraction-list preflight (raises/bets). Tree walk below is authoritative when
  // preview nodes are available — empty missing_sizes without a walk is not success.
  const missing_sizes: string[] = [];
  for (const label of action_line) {
    const frac = potFractionForPlayedSize(label, record.pot);
    if (frac == null) continue;
    const inOop = approxInList(frac, oopRiverBets);
    const inIp = approxInList(frac, ipRiverBets);
    if (!inOop && !inIp) {
      missing_sizes.push(label);
    }
  }

  const solveJob: SolveJobRequest = {
    board: [...record.board],
    oop_range: oop.range,
    ip_range: ip.range,
    pot: record.pot,
    stack: record.stack,
    oop_bets: [],
    ip_bets: [],
    oop_river_bets: oopRiverBets,
    ip_river_bets: ipRiverBets,
    max_raises: 2,
    allow_three_bet: 1,
    all_in_threshold: 0.5,
    pot_cap: 0,
    frozen: 1,
    accuracy:
      typeof options.accuracy === "number" && options.accuracy >= 0
        ? options.accuracy
        : -1,
    iterations: Math.max(1, Math.trunc(options.iterations ?? 50)),
    memory_mib: options.memoryMib ?? 256,
    threads: options.threads ?? 1,
    algorithm: "cfr_plus",
    samples: 5,
    rake_rate: 0,
    rake_cap: 0,
  };
  if (options.time_limit != null && options.time_limit > 0) {
    solveJob.time_limit = options.time_limit;
  }

  const street_config = formatSolveJobStreetConfig(solveJob);
  const warnings: string[] = [];
  if (missing_sizes.length > 0) {
    // Still emit the job; tree may not contain the played size until edited.
    warnings.push(
      `Played sizes not in tree bet lists: ${missing_sizes.join(", ")}`,
    );
  }

  let decisionActions =
    options.decisionActions ?? heuristicDecisionActions(action_line);
  let decisionPath = decisionActions.join("/");
  if (options.previewNodes?.length) {
    const validated = decisionActionsForStudy(options.previewNodes, action_line);
    for (const miss of validated.missing_sizes) {
      if (!missing_sizes.includes(miss)) missing_sizes.push(miss);
    }
    decisionActions = options.decisionActions ?? validated.actions;
    decisionPath = validated.path;
    if (!validated.ok) {
      warnings.push(
        `Played line missing from tree: ${validated.missing_sizes.join(", ")}`,
      );
    }
  }

  const review: StudyJobReview = {
    // Default seat labels for SRP-shaped spots (BB OOP / BTN IP) — not stakes.
    positions: options.positions ?? { oop: "BB", ip: "BTN" },
    board: [...record.board],
    pot: record.pot,
    effective_stack: record.stack,
    action_line,
    range_sources: { oop: oop.source, ip: ip.source },
    missing_sizes,
    street_boundary: "river",
    warnings: warnings.length ? warnings : undefined,
  };

  return {
    schema: STUDY_JOB_SCHEMA,
    street_config: street_config.endsWith("\n") ? street_config : `${street_config}\n`,
    run: {
      iterations: solveJob.iterations,
      accuracy:
        typeof solveJob.accuracy === "number" && solveJob.accuracy >= 0
          ? solveJob.accuracy
          : null,
      time_limit: solveJob.time_limit ?? null,
    },
    provenance: {
      source: "hand-history",
      created_at: options.created_at ?? new Date().toISOString(),
      created_by: "holdem-study",
      range_sources: { oop: oop.source, ip: ip.source },
      notes: `outcome=${record.outcome} terminal-pot=${trimNumber(record.terminalPot)} p0-net=${trimNumber(record.p0Net)}`,
    },
    review,
    decision: { actions: decisionActions, path: decisionPath },
  };
}

export function riverJobFromHandHistoryText(
  text: string,
  options?: RiverJobFromHandHistoryOptions,
): StudyJob {
  return riverJobFromHandHistory(parseHandHistory(text), options);
}
