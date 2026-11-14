/**
 * Study identity helpers: analysis request scoping, compare validity,
 * strategy-edit draft binding, and Build draft sync from opened status.
 */

import {
  formatDonkField,
  formatStoredSizes,
  formatStreetBetField,
  formatStreetRaiseField,
} from "../betSizes";
import type { ComparePayload } from "../locks";
import { DEFAULT_SPOT, type NodePayload, type SpotDraft, type StatusPayload } from "../types";

export type AnalysisKind = "values" | "equity" | "categories";

/** Identity key for one in-flight or published analysis result. */
export interface AnalysisIdentity {
  solutionId: string;
  nodeId: string;
  /** Status / solution revision (status_generation) when known; else 0. */
  revision: number;
  kind: AnalysisKind;
}

export function analysisIdentityKey(id: AnalysisIdentity): string {
  return `${id.solutionId}\0${id.nodeId}\0${id.revision}\0${id.kind}`;
}

export function analysisIdentitiesEqual(
  a: AnalysisIdentity | null | undefined,
  b: AnalysisIdentity | null | undefined,
): boolean {
  if (!a || !b) {
    return false;
  }
  return analysisIdentityKey(a) === analysisIdentityKey(b);
}

/**
 * True when a stored analysis payload still belongs to the live study node.
 * Prefer rejecting foreign node_id / solution_id over showing stale panels.
 */
export function analysisPayloadMatchesNode(
  payload: { node_id?: string; solution_id?: string; pending?: boolean } | null | undefined,
  solutionId: string | null | undefined,
  nodeId: string | null | undefined,
): boolean {
  if (!payload || !solutionId || !nodeId) {
    return false;
  }
  if (payload.pending) {
    return true;
  }
  if (payload.node_id != null && payload.node_id !== nodeId) {
    return false;
  }
  if (payload.solution_id != null && payload.solution_id !== solutionId) {
    return false;
  }
  return true;
}

/**
 * True when a finished successful payload belongs to the live node.
 * Settled failures (`error`) are not ready — auto-load may retry them unless
 * {@link analysisErrorIsPermanent}.
 */
export function analysisPayloadReady(
  payload:
    | { node_id?: string; solution_id?: string; pending?: boolean; error?: string }
    | null
    | undefined,
  solutionId: string | null | undefined,
  nodeId: string | null | undefined,
): boolean {
  if (!payload || payload.pending || payload.error) {
    return false;
  }
  return analysisPayloadMatchesNode(payload, solutionId, nodeId);
}

/** Work-limit (and similar) failures stay settled for the current inputs. */
export function analysisErrorIsPermanent(error: string | undefined | null): boolean {
  return Boolean(error && /work limit/i.test(error));
}

/**
 * True when auto-load should kick off a request for this payload.
 * Skips ready pages, in-flight pending for the live node, and permanent errors.
 */
export function analysisPayloadNeedsAutoload(
  payload:
    | { node_id?: string; solution_id?: string; pending?: boolean; error?: string }
    | null
    | undefined,
  solutionId: string | null | undefined,
  nodeId: string | null | undefined,
): boolean {
  if (!solutionId || !nodeId) {
    return false;
  }
  if (analysisPayloadReady(payload, solutionId, nodeId)) {
    return false;
  }
  if (payload?.pending) {
    if (payload.node_id != null && payload.node_id !== nodeId) {
      return true;
    }
    if (payload.solution_id != null && payload.solution_id !== solutionId) {
      return true;
    }
    return false;
  }
  if (payload?.error && analysisErrorIsPermanent(payload.error)) {
    return analysisPayloadMatchesNode(payload, solutionId, nodeId) ? false : true;
  }
  return true;
}

/**
 * Resolve baseline from status: explicit null clears; undefined keeps prior.
 * (`??` incorrectly retains a stale baseline when the backend sends null.)
 */
export function resolveBaselineSolutionId(
  statusBaseline: string | null | undefined,
  previous: string | null,
): string | null {
  if (statusBaseline === undefined) {
    return previous;
  }
  return statusBaseline;
}

/** Compare note is only renderable when all ids match the live relationship. */
export function compareNoteIsValid(
  note: ComparePayload | null | undefined,
  baselineId: string | null | undefined,
  scenarioId: string | null | undefined,
  nodeId: string | null | undefined,
): boolean {
  if (!note || !baselineId || !scenarioId || !nodeId) {
    return false;
  }
  return (
    note.baseline_id === baselineId &&
    note.scenario_id === scenarioId &&
    note.node_id === nodeId
  );
}

/** True when baseline/scenario relationship can no longer back the note. */
export function shouldClearCompareNote(
  note: ComparePayload | null | undefined,
  baselineId: string | null | undefined,
  scenarioId: string | null | undefined,
): boolean {
  if (!note) {
    return false;
  }
  if (!baselineId || !scenarioId) {
    return true;
  }
  if (note.baseline_id !== baselineId || note.scenario_id !== scenarioId) {
    return true;
  }
  return false;
}

/** Scope for an open strategy-edit draft — indices are only valid inside this. */
export interface StrategyEditScope {
  solutionId: string;
  nodeId: string;
  player: number | null;
  actionsSignature: string;
  combosSignature: string;
}

export function actionsSignature(actions: string[] | null | undefined): string {
  return (actions ?? []).join("\0");
}

/** Stable enough to detect combo-table identity changes without hashing every row. */
export function combosSignature(combos: string[] | null | undefined): string {
  const list = combos ?? [];
  if (list.length === 0) {
    return "0";
  }
  return `${list.length}\0${list[0]}\0${list[list.length - 1]}`;
}

export function strategyEditScopeFromNode(
  solutionId: string,
  node: Pick<NodePayload, "node_id" | "player" | "actions" | "combos">,
): StrategyEditScope {
  return {
    solutionId,
    nodeId: node.node_id,
    player: node.player ?? null,
    actionsSignature: actionsSignature(node.actions),
    combosSignature: combosSignature(node.combos),
  };
}

export function strategyEditScopesEqual(
  a: StrategyEditScope | null | undefined,
  b: StrategyEditScope | null | undefined,
): boolean {
  if (!a || !b) {
    return false;
  }
  return (
    a.solutionId === b.solutionId &&
    a.nodeId === b.nodeId &&
    a.player === b.player &&
    a.actionsSignature === b.actionsSignature &&
    a.combosSignature === b.combosSignature
  );
}

function joinBoard(board: StatusPayload["board"]): string | undefined {
  if (board == null) {
    return undefined;
  }
  if (Array.isArray(board)) {
    return board.map((card) => String(card)).join(" ");
  }
  return String(board);
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return undefined;
}

/**
 * Map opened /api/status fields onto SpotDraft.
 *
 * Status omits ranges / bet sizes / tree_edits. Callers that Open a solution
 * must replace the draft wholesale (see draftFromOpenedSolution) rather than
 * merging this partial into a prior Build draft.
 *
 * Explicit null / unset engine sentinels clear the matching Build field so a
 * previous time limit or accuracy cannot leak across solutions.
 */
export function draftPartialFromStatus(status: StatusPayload): Partial<SpotDraft> {
  const partial: Partial<SpotDraft> = {};
  const boardText = joinBoard(status.board);
  if (boardText !== undefined) {
    partial.boardText = boardText;
  }
  const pot = asFiniteNumber(status.pot);
  if (pot !== undefined) {
    partial.pot = pot;
  }
  const stack = asFiniteNumber(status.stack);
  if (stack !== undefined) {
    partial.stack = stack;
  }
  const iterations = asFiniteNumber(status.iterations_requested);
  if (iterations !== undefined && iterations > 0) {
    partial.iterations = Math.trunc(iterations);
  }
  const maxRaises = asFiniteNumber(status.max_raises);
  if (maxRaises !== undefined) {
    partial.maxRaises = Math.trunc(maxRaises);
  }
  const memoryMib = asFiniteNumber(status.memory_mib);
  if (memoryMib !== undefined) {
    partial.memoryMib = Math.trunc(memoryMib);
  }
  const threads = asFiniteNumber(status.threads);
  if (threads !== undefined && threads > 0) {
    partial.threads = Math.trunc(threads);
  }
  if (typeof status.algorithm === "string" && status.algorithm.trim()) {
    partial.algorithm = status.algorithm.trim();
  }
  const samples = asFiniteNumber(
    typeof status.samples === "number" ? status.samples : undefined,
  );
  if (samples !== undefined && samples > 0) {
    partial.samples = Math.trunc(samples);
  }
  if ("accuracy" in status) {
    const accuracy = asFiniteNumber(status.accuracy);
    // Engine uses -1 for "unset"; Build stores percent-of-pot (0.5 → 0.5%).
    partial.accuracy =
      accuracy === undefined || accuracy < 0
        ? ""
        : String(Number((accuracy * 100).toPrecision(12)));
  }
  if ("time_limit" in status) {
    const timeLimit = asFiniteNumber(status.time_limit);
    partial.timeLimit =
      timeLimit === undefined || timeLimit < 0 ? "" : String(timeLimit);
  }
  const rakeRate = asFiniteNumber(status.rake_rate);
  if (rakeRate !== undefined) {
    partial.rakeRate = rakeRate;
  }
  const rakeCap = asFiniteNumber(status.rake_cap);
  if (rakeCap !== undefined) {
    partial.rakeCap = rakeCap;
  }
  if (status.frozen != null) {
    partial.frozen = Boolean(status.frozen);
  }
  const icmStacks = status.icm_stacks;
  if (Array.isArray(icmStacks)) {
    const stacks = icmStacks
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
    if (stacks.length >= 2) {
      partial.useIcm = true;
      partial.icmStacks = stacks.join(", ");
      const payouts = Array.isArray(status.icm_payouts)
        ? status.icm_payouts
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value))
        : [];
      partial.icmPayouts = payouts.join(", ");
    } else {
      partial.useIcm = false;
      partial.icmStacks = "";
      partial.icmPayouts = "";
    }
  }
  return partial;
}

function joinConfigSizes(values: unknown): string {
  return formatStoredSizes(values);
}

/** Display raise pot fractions + multiples as Build text (`50, 2x`). */
function joinRaiseConfigSizes(fractions: unknown, multiples: unknown): string {
  const base = formatStoredSizes(fractions, { raise: true });
  const extra: string[] = [];
  if (Array.isArray(multiples)) {
    for (const value of multiples) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) {
        extra.push(`${n}x`);
      }
    }
  }
  if (base === "-") {
    return extra.length > 0 ? extra.join(", ") : "-";
  }
  return [base, ...extra].filter(Boolean).join(", ");
}

/**
 * Blank Build draft used when opening a solution so prior ranges/bets/edits
 * cannot survive as a hybrid over the newly loaded spot.
 */
export function openDraftBase(solutionPath = ""): SpotDraft {
  return {
    ...DEFAULT_SPOT,
    oopRange: "",
    ipRange: "",
    oopBets: "",
    ipBets: "",
    oopRaises: "",
    ipRaises: "",
    oopFlop: "",
    ipFlop: "",
    oopTurn: "",
    ipTurn: "",
    oopRiver: "",
    ipRiver: "",
    oopFlopRaises: "",
    ipFlopRaises: "",
    oopTurnRaises: "",
    ipTurnRaises: "",
    oopRiverRaises: "",
    ipRiverRaises: "",
    oopDonk: "",
    oopFlopDonk: "",
    oopTurnDonk: "",
    oopRiverDonk: "",
    donkFlop: false,
    donkTurn: false,
    donkRiver: false,
    potCap: 0,
    noThreeBet: false,
    allInThreshold: 0.5,
    accuracy: "",
    timeLimit: "",
    useIcm: false,
    icmStacks: "",
    icmPayouts: "",
    incentives: "",
    edgeTags: "",
    treeEdits: [],
    solutionPath,
  };
}

/**
 * Map GET /api/solutions/{id}/config (or POST /api/config) JSON onto SpotDraft.
 * Empty per-street lists (inherit) are resolved into shared sizes so Build text
 * rebuilds the same tree. Explicit-empty stays blank (check-only) or `-`.
 */
export function draftPartialFromSolutionConfig(
  config: Record<string, unknown>,
): Partial<SpotDraft> {
  const partial: Partial<SpotDraft> = {};
  if (Array.isArray(config.board) || typeof config.board === "string") {
    const boardText = joinBoard(config.board as StatusPayload["board"]);
    if (boardText !== undefined) {
      partial.boardText = boardText;
    }
  }
  const pot = asFiniteNumber(config.pot);
  if (pot !== undefined) {
    partial.pot = pot;
  }
  const stack = asFiniteNumber(config.stack);
  if (stack !== undefined) {
    partial.stack = stack;
  }
  if (typeof config.oop_range === "string") {
    partial.oopRange = config.oop_range;
  }
  if (typeof config.ip_range === "string") {
    partial.ipRange = config.ip_range;
  }
  if ("oop_bets" in config) {
    partial.oopBets = joinConfigSizes(config.oop_bets);
  }
  if ("ip_bets" in config) {
    partial.ipBets = joinConfigSizes(config.ip_bets);
  }
  if ("oop_raises" in config || "oop_raise_multiples" in config) {
    partial.oopRaises = joinRaiseConfigSizes(
      config.oop_raises,
      config.oop_raise_multiples,
    );
  }
  if ("ip_raises" in config || "ip_raise_multiples" in config) {
    partial.ipRaises = joinRaiseConfigSizes(
      config.ip_raises,
      config.ip_raise_multiples,
    );
  }
  if ("oop_flop_bets" in config || "oop_bets" in config) {
    partial.oopFlop = formatStreetBetField(
      config.oop_flop_bets,
      config.oop_bets,
    );
  }
  if ("ip_flop_bets" in config || "ip_bets" in config) {
    partial.ipFlop = formatStreetBetField(
      config.ip_flop_bets,
      config.ip_bets,
    );
  }
  if ("oop_turn_bets" in config || "oop_bets" in config) {
    partial.oopTurn = formatStreetBetField(
      config.oop_turn_bets,
      config.oop_bets,
    );
  }
  if ("ip_turn_bets" in config || "ip_bets" in config) {
    partial.ipTurn = formatStreetBetField(
      config.ip_turn_bets,
      config.ip_bets,
    );
  }
  if ("oop_river_bets" in config || "oop_bets" in config) {
    partial.oopRiver = formatStreetBetField(
      config.oop_river_bets,
      config.oop_bets,
    );
  }
  if ("ip_river_bets" in config || "ip_bets" in config) {
    partial.ipRiver = formatStreetBetField(
      config.ip_river_bets,
      config.ip_bets,
    );
  }
  if ("oop_flop_raises" in config || "oop_raises" in config) {
    partial.oopFlopRaises = formatStreetRaiseField(
      config.oop_flop_raises,
      config.oop_raises,
      config.oop_flop_bets,
      { sharedBets: config.oop_bets },
    );
  }
  if ("ip_flop_raises" in config || "ip_raises" in config) {
    partial.ipFlopRaises = formatStreetRaiseField(
      config.ip_flop_raises,
      config.ip_raises,
      config.ip_flop_bets,
      { sharedBets: config.ip_bets },
    );
  }
  if ("oop_turn_raises" in config || "oop_raises" in config) {
    partial.oopTurnRaises = formatStreetRaiseField(
      config.oop_turn_raises,
      config.oop_raises,
      config.oop_turn_bets,
      { sharedBets: config.oop_bets },
    );
  }
  if ("ip_turn_raises" in config || "ip_raises" in config) {
    partial.ipTurnRaises = formatStreetRaiseField(
      config.ip_turn_raises,
      config.ip_raises,
      config.ip_turn_bets,
      { sharedBets: config.ip_bets },
    );
  }
  if ("oop_river_raises" in config || "oop_raises" in config) {
    partial.oopRiverRaises = formatStreetRaiseField(
      config.oop_river_raises,
      config.oop_raises,
      config.oop_river_bets,
      { sharedBets: config.oop_bets },
    );
  }
  if ("ip_river_raises" in config || "ip_raises" in config) {
    partial.ipRiverRaises = formatStreetRaiseField(
      config.ip_river_raises,
      config.ip_raises,
      config.ip_river_bets,
      { sharedBets: config.ip_bets },
    );
  }
  if ("oop_donk" in config) {
    partial.oopDonk = joinConfigSizes(config.oop_donk);
  }
  if ("oop_flop_donk" in config || "oop_donk" in config || "oop_flop_bets" in config) {
    const donk = formatDonkField(
      config.oop_flop_donk,
      config.oop_flop_bets ?? config.oop_bets,
      config.oop_donk,
    );
    partial.oopFlopDonk = donk.text;
    partial.donkFlop = donk.copyBets;
  }
  if ("oop_turn_donk" in config || "oop_donk" in config || "oop_turn_bets" in config) {
    const donk = formatDonkField(
      config.oop_turn_donk,
      config.oop_turn_bets ?? config.oop_bets,
      config.oop_donk,
    );
    partial.oopTurnDonk = donk.text;
    partial.donkTurn = donk.copyBets;
  }
  if ("oop_river_donk" in config || "oop_donk" in config || "oop_river_bets" in config) {
    const donk = formatDonkField(
      config.oop_river_donk,
      config.oop_river_bets ?? config.oop_bets,
      config.oop_donk,
    );
    partial.oopRiverDonk = donk.text;
    partial.donkRiver = donk.copyBets;
  }
  const mergeThreshold = asFiniteNumber(config.merge_threshold);
  if (mergeThreshold !== undefined) {
    partial.mergeThresholdPct = mergeThreshold * 100;
  }
  const maxRaises = asFiniteNumber(config.max_raises);
  if (maxRaises !== undefined) {
    partial.maxRaises = Math.trunc(maxRaises);
  }
  if ("allow_three_bet" in config) {
    partial.noThreeBet = config.allow_three_bet === false;
  }
  const potCap = asFiniteNumber(config.pot_cap);
  if (potCap !== undefined) {
    partial.potCap = potCap;
  }
  const allInThreshold = asFiniteNumber(config.all_in_threshold);
  if (allInThreshold !== undefined) {
    partial.allInThreshold = allInThreshold;
  }
  const memoryMib = asFiniteNumber(config.memory_mib);
  if (memoryMib !== undefined) {
    partial.memoryMib = Math.trunc(memoryMib);
  }
  const threads = asFiniteNumber(config.threads);
  if (threads !== undefined && threads > 0) {
    partial.threads = Math.trunc(threads);
  }
  if (typeof config.algorithm === "string" && config.algorithm.trim()) {
    partial.algorithm = config.algorithm.trim();
  }
  if ("frozen" in config) {
    partial.frozen = Boolean(config.frozen);
  }
  const samples = asFiniteNumber(config.samples);
  if (samples !== undefined && samples > 0) {
    partial.samples = Math.trunc(samples);
  }
  if ("accuracy" in config) {
    const accuracy = asFiniteNumber(config.accuracy);
    // Config Accuracy is pot fraction; Build field is percent of pot.
    partial.accuracy =
      accuracy === undefined || accuracy < 0
        ? ""
        : String(Number((accuracy * 100).toPrecision(12)));
  }
  if ("time_limit" in config) {
    const timeLimit = asFiniteNumber(config.time_limit);
    partial.timeLimit =
      timeLimit === undefined || timeLimit < 0 ? "" : String(timeLimit);
  }
  const iterations = asFiniteNumber(config.iterations);
  if (iterations !== undefined && iterations > 0) {
    partial.iterations = Math.trunc(iterations);
  }
  const rakeRate = asFiniteNumber(config.rake_rate);
  if (rakeRate !== undefined) {
    partial.rakeRate = rakeRate;
  }
  const rakeCap = asFiniteNumber(config.rake_cap);
  if (rakeCap !== undefined) {
    partial.rakeCap = rakeCap;
  }
  if (Array.isArray(config.icm_stacks)) {
    const stacks = config.icm_stacks
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
    if (stacks.length >= 2) {
      partial.useIcm = true;
      partial.icmStacks = stacks.join(", ");
      partial.icmPayouts = Array.isArray(config.icm_payouts)
        ? config.icm_payouts
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value))
            .join(", ")
        : "";
    } else {
      partial.useIcm = false;
      partial.icmStacks = "";
      partial.icmPayouts = "";
    }
  }
  if (Array.isArray(config.tree_edits)) {
    partial.treeEdits = config.tree_edits.map((line) => String(line)).filter(Boolean);
  }
  return partial;
}

export interface OpenedSolutionDraftResult {
  draft: SpotDraft;
  /** True when solution config supplied ranges and/or bet sizes. */
  configComplete: boolean;
  warnings: string[];
}

/**
 * Wholesale Build draft for Open: start from a cleared base, apply solution
 * config when available, then status. Never merges into a prior draft.
 */
export function draftFromOpenedSolution(args: {
  solutionPath: string;
  status?: StatusPayload | null;
  config?: Record<string, unknown> | null;
}): OpenedSolutionDraftResult {
  const warnings: string[] = [];
  let draft = openDraftBase(args.solutionPath);
  const config = args.config && typeof args.config === "object" ? args.config : null;
  const configComplete = Boolean(
    config &&
      (typeof config.oop_range === "string" ||
        typeof config.ip_range === "string" ||
        "oop_bets" in config ||
        "ip_bets" in config ||
        "oop_flop_bets" in config),
  );
  if (config) {
    draft = { ...draft, ...draftPartialFromSolutionConfig(config) };
  } else {
    warnings.push(
      "Solution config unavailable; ranges and bet sizes were cleared rather than kept from the previous draft.",
    );
  }
  if (args.status) {
    draft = { ...draft, ...draftPartialFromStatus(args.status) };
  }
  draft = { ...draft, solutionPath: args.solutionPath };
  return { draft, configComplete, warnings };
}
