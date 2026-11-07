/**
 * Prominent bluffs: betting hands with check-down equity below a threshold.
 * Local betting predicate — do not change browse.isAggressive.
 */
import type { EquityHandRow } from "./analysis";
import { comboKey } from "./matrixDisplay";
import { RANKS, type NodePayload } from "./types";

/** UI default; callers pass the live threshold from panel state. */
export const DEFAULT_BLUFF_EQUITY_THRESHOLD = 0.3;

/** Include only when bet frequency is at least this fraction. */
export const MIN_BET_FREQ = 0.01;

export type BluffEquityMode = "node" | "after_call";

export interface ProminentBluffRow {
  combo: string;
  betFreq: number;
  equity: number;
  /** Betting action with the largest probability for this hand, if any. */
  topBetAction: string | null;
  weight: number | null;
  reach: number | null;
}

export interface SelectedMatrixCell {
  row: number;
  col: number;
  text: string;
}

/**
 * Bluff-tool betting actions: Bet*, Raise*, and bare All-in.
 * Sized `Bet N all-in` / `Raise … all-in` already match Bet/Raise prefixes.
 */
export function isBluffBettingAction(label: string): boolean {
  const trimmed = label.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith("Bet") || trimmed.startsWith("Raise")) {
    return true;
  }
  return /^all[\s-]*in$/i.test(trimmed);
}

/** Sum of betting-action probabilities for one strategy row. */
export function betFrequency(
  strategyRow: number[] | null | undefined,
  actions: string[] | null | undefined,
): number {
  if (!strategyRow?.length || !actions?.length) {
    return 0;
  }
  let sum = 0;
  const n = Math.min(strategyRow.length, actions.length);
  for (let index = 0; index < n; index += 1) {
    if (!isBluffBettingAction(actions[index] ?? "")) {
      continue;
    }
    const probability = Number(strategyRow[index]);
    if (Number.isFinite(probability) && probability > 0) {
      sum += probability;
    }
  }
  return sum;
}

/** Betting label with the largest probability on this row (ties → first). */
export function topBettingAction(
  strategyRow: number[] | null | undefined,
  actions: string[] | null | undefined,
): string | null {
  if (!strategyRow?.length || !actions?.length) {
    return null;
  }
  let bestLabel: string | null = null;
  let bestProb = -1;
  const n = Math.min(strategyRow.length, actions.length);
  for (let index = 0; index < n; index += 1) {
    const label = actions[index] ?? "";
    if (!isBluffBettingAction(label)) {
      continue;
    }
    const probability = Number(strategyRow[index]);
    if (!Number.isFinite(probability) || probability <= bestProb) {
      continue;
    }
    bestProb = probability;
    bestLabel = label;
  }
  return bestLabel;
}

/**
 * Map a 4-char combo onto the Study 169-cell {row,col,text}.
 * Mirrors groupHands placement in browse.ts.
 */
export function matrixCellForCombo(combo: string): SelectedMatrixCell | null {
  const key = comboKey(combo);
  if (key.length < 4) {
    return null;
  }
  const high = RANKS.indexOf(key[0] as (typeof RANKS)[number]);
  const low = RANKS.indexOf(key[2] as (typeof RANKS)[number]);
  if (high < 0 || low < 0) {
    return null;
  }
  const suited = key[1] === key[3];
  let row = high;
  let col = low;
  if (key[0] !== key[2] && suited) {
    row = Math.min(high, low);
    col = Math.max(high, low);
  } else if (key[0] !== key[2]) {
    row = Math.max(high, low);
    col = Math.min(high, low);
  }
  const text =
    key[0] === key[2]
      ? `${RANKS[row]}${RANKS[col]}`
      : row < col
        ? `${RANKS[row]}${RANKS[col]}s`
        : `${RANKS[col]}${RANKS[row]}o`;
  return { row, col, text };
}

function equityLookup(
  hands: EquityHandRow[] | null | undefined,
): Map<string, { equity: number; weight: number }> {
  const map = new Map<string, { equity: number; weight: number }>();
  if (!hands?.length) {
    return map;
  }
  for (const hand of hands) {
    const equity = Number(hand.equity);
    if (!hand.combo || !Number.isFinite(equity)) {
      continue;
    }
    map.set(comboKey(hand.combo), {
      equity,
      weight: Number(hand.weight),
    });
  }
  return map;
}

function isDecisionWithStrategy(node: NodePayload | null | undefined): boolean {
  if (!node) {
    return false;
  }
  if (node.kind === "chance" || node.kind === "terminal") {
    return false;
  }
  const actions = node.actions;
  const combos = node.combos;
  const strategy = node.strategy;
  return Boolean(actions?.length && combos?.length && strategy?.length);
}

export interface ListProminentBluffsArgs {
  node: NodePayload | null | undefined;
  /** Acting-seat check-down equity hands (Mode A: current node). */
  equityHands: EquityHandRow[] | null | undefined;
  /** Exclusive upper bound: equity < threshold. */
  threshold: number;
  /** Reserved for Mode B; Mode A ignores and uses equityHands. */
  equityMode?: BluffEquityMode;
  minBetFreq?: number;
}

/**
 * Prominent bluffs for the acting seat at a decision node.
 * Sort: descending betFreq, then combo localeCompare.
 */
export function listProminentBluffs(args: ListProminentBluffsArgs): ProminentBluffRow[] {
  const {
    node,
    equityHands,
    threshold,
    minBetFreq = MIN_BET_FREQ,
  } = args;
  if (!isDecisionWithStrategy(node) || !Number.isFinite(threshold)) {
    return [];
  }
  const actions = node!.actions ?? [];
  const combos = node!.combos ?? [];
  const strategy = node!.strategy ?? [];
  const reach = Array.isArray(node!.reach) ? (node!.reach as number[]) : null;
  const byCombo = equityLookup(equityHands);
  const rows: ProminentBluffRow[] = [];

  for (let index = 0; index < combos.length; index += 1) {
    const combo = combos[index];
    if (!combo) {
      continue;
    }
    const row = strategy[index];
    const betFreq = betFrequency(row, actions);
    if (!(betFreq >= minBetFreq)) {
      continue;
    }
    const equityEntry = byCombo.get(comboKey(combo));
    if (!equityEntry || !(equityEntry.equity < threshold)) {
      continue;
    }
    const handReach =
      reach && node!.reach_defined ? Number(reach[index] ?? 0) : null;
    rows.push({
      combo,
      betFreq,
      equity: equityEntry.equity,
      topBetAction: topBettingAction(row, actions),
      weight: Number.isFinite(equityEntry.weight) ? equityEntry.weight : null,
      reach: handReach != null && Number.isFinite(handReach) ? handReach : null,
    });
  }

  rows.sort((left, right) => {
    const delta = right.betFreq - left.betFreq;
    if (delta !== 0) {
      return delta;
    }
    return left.combo.localeCompare(right.combo);
  });
  return rows;
}
