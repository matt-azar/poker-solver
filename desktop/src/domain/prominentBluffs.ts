/**
 * Prominent bluffs: betting hands with check-down equity below a threshold.
 * Local betting predicate — do not change browse.isAggressive.
 */
import type { EquityHandRow } from "./analysis";
import { comboEv, comboKey } from "./matrixDisplay";
import {
  RANKS,
  type ActionValuesPayload,
  type EvDisplayBasis,
  type NodePayload,
} from "./types";

/** Local copy of features/matrix/childIdAt — keep domain free of features imports. */
function childIdAt(
  children: unknown[] | undefined,
  index: number,
): string | null {
  if (!children) {
    return null;
  }
  const child = children[index];
  if (!child) {
    return null;
  }
  if (typeof child === "string") {
    return child;
  }
  if (
    typeof child === "object" &&
    child !== null &&
    "node_id" in child &&
    typeof (child as { node_id?: unknown }).node_id === "string" &&
    (child as { node_id: string }).node_id
  ) {
    return (child as { node_id: string }).node_id;
  }
  return null;
}

/** UI default; callers pass the live threshold from panel state. */
export const DEFAULT_BLUFF_EQUITY_THRESHOLD = 0.3;

/** Include only when bet frequency is at least this fraction. */
export const MIN_BET_FREQ = 0.01;

export type BluffEquityMode = "node" | "after_call";

export interface ProminentBluffRow {
  combo: string;
  betFreq: number;
  /** Mixed action EV (chips) for the combo; null when values pending/undefined. */
  ev: number | null;
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

/** True when the label is a Call (not Check). */
export function isCallAction(label: string): boolean {
  return /^call\b/i.test(label.trim());
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

/**
 * Index of the betting action with the largest probability (ties → first).
 * Returns -1 when no betting action has positive mass.
 */
export function topBettingActionIndex(
  strategyRow: number[] | null | undefined,
  actions: string[] | null | undefined,
): number {
  if (!strategyRow?.length || !actions?.length) {
    return -1;
  }
  let bestIndex = -1;
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
    bestIndex = index;
  }
  return bestIndex;
}

/** Betting label with the largest probability on this row (ties → first). */
export function topBettingAction(
  strategyRow: number[] | null | undefined,
  actions: string[] | null | undefined,
): string | null {
  if (!actions?.length) {
    return null;
  }
  const index = topBettingActionIndex(strategyRow, actions);
  return index >= 0 ? (actions[index] ?? null) : null;
}

/** First Call action index on a facing node, or -1. */
export function callActionIndex(actions: string[] | null | undefined): number {
  if (!actions?.length) {
    return -1;
  }
  return actions.findIndex((label) => isCallAction(label));
}

/** Facing-node child id for a betting action on the hero decision node. */
export function facingChildIdForBet(
  node: Pick<NodePayload, "children"> | null | undefined,
  betActionIndex: number,
): string | null {
  if (betActionIndex < 0) {
    return null;
  }
  return childIdAt(node?.children as unknown[] | undefined, betActionIndex);
}

/** Call-child node id from an opponent facing-bet node. */
export function callChildIdFromFacing(
  facing: Pick<NodePayload, "actions" | "children"> | null | undefined,
): string | null {
  const index = callActionIndex(facing?.actions);
  if (index < 0) {
    return null;
  }
  return childIdAt(facing?.children as unknown[] | undefined, index);
}

/**
 * Distinct betting-action indices that are the max-prob size for at least one
 * combo with betFreq >= minBetFreq (Mode B multi-size default).
 */
export function dominantBettingActionIndices(
  node: NodePayload | null | undefined,
  minBetFreq = MIN_BET_FREQ,
): number[] {
  if (!isDecisionWithStrategy(node)) {
    return [];
  }
  const actions = node!.actions ?? [];
  const combos = node!.combos ?? [];
  const strategy = node!.strategy ?? [];
  const seen = new Set<number>();
  for (let index = 0; index < combos.length; index += 1) {
    const row = strategy[index];
    if (!(betFrequency(row, actions) >= minBetFreq)) {
      continue;
    }
    const actionIndex = topBettingActionIndex(row, actions);
    if (actionIndex >= 0) {
      seen.add(actionIndex);
    }
  }
  return [...seen].sort((left, right) => left - right);
}

/**
 * Build acting-seat equity rows for Mode B: each combo uses equity from the
 * Call-child payload of its dominant betting size.
 */
export function equityHandsForDominantSizes(args: {
  node: NodePayload | null | undefined;
  /** betActionIndex → acting-seat equity hands at that size's Call child */
  handsByBetAction: Map<number, EquityHandRow[] | null | undefined>;
  minBetFreq?: number;
}): EquityHandRow[] {
  const { node, handsByBetAction, minBetFreq = MIN_BET_FREQ } = args;
  if (!isDecisionWithStrategy(node)) {
    return [];
  }
  const actions = node!.actions ?? [];
  const combos = node!.combos ?? [];
  const strategy = node!.strategy ?? [];
  const out: EquityHandRow[] = [];
  for (let index = 0; index < combos.length; index += 1) {
    const combo = combos[index];
    if (!combo) {
      continue;
    }
    const row = strategy[index];
    if (!(betFrequency(row, actions) >= minBetFreq)) {
      continue;
    }
    const actionIndex = topBettingActionIndex(row, actions);
    if (actionIndex < 0) {
      continue;
    }
    const hands = handsByBetAction.get(actionIndex);
    if (!hands?.length) {
      continue;
    }
    const key = comboKey(combo);
    const match = hands.find((hand) => comboKey(hand.combo) === key);
    if (!match || !Number.isFinite(Number(match.equity))) {
      continue;
    }
    out.push({
      combo,
      equity: Number(match.equity),
      weight: Number(match.weight),
    });
  }
  return out;
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
  /** Optional node `/values` payload — mixed EV via {@link comboEv}. */
  nodeValues?: ActionValuesPayload | null;
  /** Display basis for EV; defaults to Study local (Fold = 0). */
  evDisplayBasis?: EvDisplayBasis;
}

/**
 * Prominent bluffs for the acting seat at a decision node.
 * Sort: descending betFreq, then combo localeCompare.
 * EV is display-only (does not filter); null when values are missing/pending.
 */
export function listProminentBluffs(args: ListProminentBluffsArgs): ProminentBluffRow[] {
  const {
    node,
    equityHands,
    threshold,
    minBetFreq = MIN_BET_FREQ,
    nodeValues = null,
    evDisplayBasis = "local",
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
      ev: comboEv(node, nodeValues, combo, evDisplayBasis),
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
