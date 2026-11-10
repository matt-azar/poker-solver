/** Pure helpers for node-lock editing. Zero probability is a real constraint; unlock is separate. */

import { formatPublicNodeId, parsePublicNodeId } from "./cards";

export type LockScope = "node" | "line";

export interface LockRecord {
  node_id: string;
  infoset_id?: number;
  /** Exact board vs every runout of the betting line. Omitted on older payloads. */
  scope?: LockScope;
  kind: "full" | "selected";
  hand_indices: number[];
  probs: number[];
}

export interface LocksPayload {
  locks: LockRecord[];
}

export interface CompareHandRow {
  combo: string;
  locked: boolean;
  baseline: number[];
  scenario: number[];
  delta: number[];
}

export interface ComparePayload {
  baseline_id: string;
  scenario_id: string;
  node_id: string;
  baseline_value: number;
  scenario_value: number;
  value_delta: number;
  baseline_nash_gap: number;
  scenario_nash_gap: number;
  actions: string[];
  hands: CompareHandRow[];
  units?: string;
  utility_basis?: string;
}

export interface LockDraft {
  kind: "full" | "selected";
  handIndices: number[];
  probs: number[];
}

export function emptyProbs(actionCount: number): number[] {
  return Array.from({ length: actionCount }, () => 0);
}

export function uniformProbs(actionCount: number): number[] {
  if (actionCount <= 0) {
    return [];
  }
  const each = 1 / actionCount;
  return Array.from({ length: actionCount }, () => each);
}

export function normalizeProbs(probs: number[]): {
  probs: number[];
  sum: number;
  valid: boolean;
  reason?: string;
} {
  const cleaned = probs.map((value) => (Number.isFinite(value) && value >= 0 ? value : 0));
  const sum = cleaned.reduce((acc, value) => acc + value, 0);
  if (!(sum > 0)) {
    // Engine rejects a zero-sum row. Zero on an individual action is still a real constraint
    // inside a row that sums to ~1; unlocking is DELETE, not an all-zero PUT.
    return {
      probs: cleaned,
      sum,
      valid: false,
      reason: "probabilities must sum to 1 (0% on an action is fine; all-zero is not unlock)",
    };
  }
  return {
    probs: cleaned.map((value) => value / sum),
    sum,
    valid: true,
  };
}

export function probsNearlyEqual(left: number[], right: number[], eps = 1e-9): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index++) {
    if (Math.abs(left[index] - right[index]) > eps) {
      return false;
    }
  }
  return true;
}

export function handIndexForCombo(combos: string[] | undefined, combo: string): number {
  if (!combos) {
    return -1;
  }
  return combos.indexOf(combo);
}

/** Line-scoped lock id for the same public betting index (pN.t-1.r-1). */
export function lineLockNodeId(nodeId: string): string | null {
  const parts = parsePublicNodeId(nodeId);
  if (!parts) {
    return null;
  }
  return formatPublicNodeId({ index: parts.index, turn: -1, river: -1 });
}

/**
 * Active lock for a browsed node: exact runout first, then line lock for the
 * same public index (engine find_for_runout semantics).
 */
export function lockForNode(locks: LockRecord[], nodeId: string): LockRecord | null {
  const exact = locks.find((entry) => entry.node_id === nodeId);
  if (exact) {
    return exact;
  }
  const lineId = lineLockNodeId(nodeId);
  if (!lineId || lineId === nodeId) {
    return null;
  }
  return locks.find((entry) => entry.node_id === lineId) ?? null;
}

export function isHandLocked(lock: LockRecord | null, handIndex: number): boolean {
  if (!lock) {
    return false;
  }
  if (lock.kind === "full") {
    return true;
  }
  return lock.hand_indices.includes(handIndex);
}

export function toggleHandIndex(selected: number[], handIndex: number): number[] {
  if (selected.includes(handIndex)) {
    return selected.filter((index) => index !== handIndex);
  }
  return [...selected, handIndex].sort((a, b) => a - b);
}

export function seedProbsFromStrategy(
  strategy: number[][] | null | undefined,
  handIndices: number[],
  actionCount: number,
): number[] {
  if (!strategy || handIndices.length === 0 || actionCount <= 0) {
    return uniformProbs(actionCount);
  }
  const totals = emptyProbs(actionCount);
  let mass = 0;
  for (const handIndex of handIndices) {
    const row = strategy[handIndex];
    if (!row || row.length !== actionCount) {
      continue;
    }
    mass += 1;
    row.forEach((probability, actionIndex) => {
      totals[actionIndex] += probability;
    });
  }
  if (!(mass > 0)) {
    return uniformProbs(actionCount);
  }
  return totals.map((value) => value / mass);
}

/**
 * Weighted mix of strategy rows for a set of hand indices.
 * Prefers engine marginal when present; otherwise equal weight among listed hands.
 * Returns null when no usable rows contribute mass.
 */
export function weightedStrategyMix(
  strategy: number[][] | null | undefined,
  handIndices: number[],
  actionCount: number,
  marginal?: number[] | null,
): number[] | null {
  if (!strategy || handIndices.length === 0 || actionCount <= 0) {
    return null;
  }
  const totals = emptyProbs(actionCount);
  let mass = 0;
  for (const handIndex of handIndices) {
    const row = strategy[handIndex];
    if (!row || row.length !== actionCount) {
      continue;
    }
    const weight =
      marginal && Number.isFinite(marginal[handIndex])
        ? Math.max(0, Number(marginal[handIndex]))
        : 1;
    if (!(weight > 0)) {
      continue;
    }
    mass += weight;
    row.forEach((probability, actionIndex) => {
      totals[actionIndex] += weight * Math.max(0, Number(probability) || 0);
    });
  }
  if (!(mass > 0)) {
    return null;
  }
  return totals.map((value) => value / mass);
}

/**
 * Set one action probability and redistribute the remainder across the others
 * in proportion to their previous shares (Pio-style linked sliders).
 */
export function setLinkedActionProb(
  probs: number[],
  index: number,
  value: number,
): number[] {
  const actionCount = probs.length;
  if (actionCount <= 0 || index < 0 || index >= actionCount) {
    return probs.slice();
  }
  const target = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  if (actionCount === 1) {
    return [1];
  }
  const next = probs.map((entry) =>
    Number.isFinite(entry) && entry >= 0 ? entry : 0,
  );
  const others = next.reduce(
    (sum, entry, actionIndex) => (actionIndex === index ? sum : sum + entry),
    0,
  );
  const remaining = 1 - target;
  next[index] = target;
  if (others > 1e-12) {
    for (let actionIndex = 0; actionIndex < actionCount; actionIndex++) {
      if (actionIndex === index) {
        continue;
      }
      next[actionIndex] = (next[actionIndex] / others) * remaining;
    }
  } else {
    const each = remaining / (actionCount - 1);
    for (let actionIndex = 0; actionIndex < actionCount; actionIndex++) {
      if (actionIndex === index) {
        continue;
      }
      next[actionIndex] = each;
    }
  }
  return next;
}

export function formatProbPct(probability: number): string {
  return `${(probability * 100).toFixed(1)}%`;
}

/**
 * After a lock mutation await: write the draft only when solution+node still
 * match. Same-solution node navigation may still accept the locks list refresh.
 */
export function lockMutationCompletion(args: {
  requestSolutionId: string;
  requestNodeId: string;
  liveSolutionId: string | null | undefined;
  liveNodeId: string | null | undefined;
}): { applyLocksList: boolean; applyDraft: boolean } {
  if (
    !args.liveSolutionId ||
    args.liveSolutionId !== args.requestSolutionId
  ) {
    return { applyLocksList: false, applyDraft: false };
  }
  if (!args.liveNodeId || args.liveNodeId !== args.requestNodeId) {
    return { applyLocksList: true, applyDraft: false };
  }
  return { applyLocksList: true, applyDraft: true };
}
