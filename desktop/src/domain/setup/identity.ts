/**
 * Study identity helpers: analysis request scoping, compare validity,
 * strategy-edit draft binding, and Build draft sync from opened status.
 */

import type { ComparePayload } from "../locks";
import type { NodePayload, SpotDraft, StatusPayload } from "../types";

export type AnalysisKind = "values" | "runouts" | "equity" | "categories";

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
 * Limitation: status does not currently expose oop/ip ranges, bet-size lists,
 * or tree_edits — those stay unchanged until the engine returns them.
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
  const accuracy = asFiniteNumber(status.accuracy);
  if (accuracy !== undefined) {
    // Engine uses -1 for "unset"; keep Build blank in that case.
    partial.accuracy = accuracy < 0 ? "" : String(accuracy);
  }
  const timeLimit = asFiniteNumber(status.time_limit);
  if (timeLimit !== undefined) {
    partial.timeLimit = timeLimit < 0 ? "" : String(timeLimit);
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
