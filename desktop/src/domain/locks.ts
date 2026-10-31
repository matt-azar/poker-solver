/** Pure helpers for node-lock editing. Zero probability is a real constraint; unlock is separate. */

export interface LockRecord {
  node_id: string;
  infoset_id?: number;
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

export function lockForNode(locks: LockRecord[], nodeId: string): LockRecord | null {
  return locks.find((entry) => entry.node_id === nodeId) ?? null;
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

export function formatProbPct(probability: number): string {
  return `${(probability * 100).toFixed(1)}%`;
}
