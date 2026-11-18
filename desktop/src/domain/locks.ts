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
  /** Legacy shared mix (every locked combo gets the same row). */
  probs: number[];
  /** Per-combo mixes parallel to `hand_indices` (Pio-style freeze). */
  combo_probs?: number[][];
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
  /** Node weight for the baseline strategy (marginal/reach). */
  baseline_weight?: number;
  /** Node weight for the revised strategy (marginal/reach). */
  scenario_weight?: number;
}

export interface CompareActionSummary {
  action: string;
  baseline: number;
  scenario: number;
  delta: number;
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
  /** Weighted action aggregates; each strategy uses its own node weights. */
  action_summary?: CompareActionSummary[];
  board?: string[] | string | null;
  player?: number | null;
  pot?: number | null;
  units?: string;
  /** Root chip EV is OOP-centered unless otherwise stated. */
  utility_basis?: string;
}

/** Per-combo mixes keyed by hand index so selection changes cannot attach the wrong row. */
export type ComboProbsByHand = Record<number, number[]>;

export interface LockDraft {
  kind: "full" | "selected";
  handIndices: number[];
  probs: number[];
  /**
   * Per-combo mixes keyed by combo identity (hand index).
   * Prefer this over parallel arrays — toggle/select must not reuse rows by position.
   */
  comboProbsByHand?: ComboProbsByHand;
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

function lockScope(entry: LockRecord): LockScope {
  if (entry.scope === "line" || entry.scope === "node") {
    return entry.scope;
  }
  // Legacy payloads without scope: t-1.r-1 ids were line-wide.
  const parts = parsePublicNodeId(entry.node_id);
  if (parts && parts.turn < 0 && parts.river < 0) {
    return "line";
  }
  return "node";
}

/**
 * Active lock for a browsed node: exact node-scope board first, then line.
 * Scope distinguishes flop-root node (`at -1 -1`) from line (`line`).
 */
export function lockForNode(locks: LockRecord[], nodeId: string): LockRecord | null {
  const exact = locks.find(
    (entry) => entry.node_id === nodeId && lockScope(entry) === "node",
  );
  if (exact) {
    return exact;
  }
  const parts = parsePublicNodeId(nodeId);
  if (!parts) {
    return null;
  }
  return (
    locks.find((entry) => {
      if (lockScope(entry) !== "line") {
        return false;
      }
      const lineParts = parsePublicNodeId(entry.node_id);
      return lineParts?.index === parts.index;
    }) ?? null
  );
}

export function isHandLocked(lock: LockRecord | null, handIndex: number): boolean {
  if (!lock) {
    return false;
  }
  // Unlock-all sentinel: full kind with no probs.
  if (
    lock.kind === "full" &&
    (!lock.probs || lock.probs.length === 0) &&
    (!lock.combo_probs || lock.combo_probs.length === 0)
  ) {
    return false;
  }
  if (lock.combo_probs && lock.combo_probs.length > 0) {
    return lock.hand_indices.includes(handIndex);
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
 * Per-combo locked mixes from the browsed strategy (Pio freeze).
 * Returns null when no usable rows exist for the listed hands.
 */
export function seedComboProbsFromStrategy(
  strategy: number[][] | null | undefined,
  handIndices: number[],
  actionCount: number,
): number[][] | null {
  const byHand = seedComboProbsByHandFromStrategy(strategy, handIndices, actionCount);
  if (!byHand) {
    return null;
  }
  return comboProbsRowsForHands(byHand, handIndices);
}

/** Seed per-combo mixes keyed by hand index from the browsed strategy. */
export function seedComboProbsByHandFromStrategy(
  strategy: number[][] | null | undefined,
  handIndices: number[],
  actionCount: number,
): ComboProbsByHand | null {
  if (!strategy || handIndices.length === 0 || actionCount <= 0) {
    return null;
  }
  const byHand: ComboProbsByHand = {};
  for (const handIndex of handIndices) {
    const row = strategy[handIndex];
    if (!row || row.length !== actionCount) {
      return null;
    }
    const normalized = normalizeProbs(row);
    if (!normalized.valid) {
      return null;
    }
    byHand[handIndex] = normalized.probs;
  }
  return byHand;
}

/** Parallel rows for `handIndices` from an identity-keyed map (missing → null). */
export function comboProbsRowsForHands(
  byHand: ComboProbsByHand | null | undefined,
  handIndices: number[],
): number[][] | null {
  if (!byHand || handIndices.length === 0) {
    return null;
  }
  const rows: number[][] = [];
  for (const handIndex of handIndices) {
    const row = byHand[handIndex];
    if (!row) {
      return null;
    }
    rows.push(row.slice());
  }
  return rows;
}

/** Build an identity-keyed map from parallel handIndices + comboProbs rows. */
export function comboProbsByHandFromRows(
  handIndices: number[],
  rows: number[][] | null | undefined,
): ComboProbsByHand | undefined {
  if (!rows || rows.length !== handIndices.length || handIndices.length === 0) {
    return undefined;
  }
  const byHand: ComboProbsByHand = {};
  for (let i = 0; i < handIndices.length; i++) {
    byHand[handIndices[i]] = rows[i].slice();
  }
  return byHand;
}

/**
 * Keep edited mixes for still-selected combos; seed newly selected from strategy.
 * Drops rows for deselected combos so they cannot attach to a later selection.
 */
export function rematerializeComboProbsByHand(args: {
  previous?: ComboProbsByHand | null;
  nextHandIndices: number[];
  strategy: number[][] | null | undefined;
  actionCount: number;
}): ComboProbsByHand | undefined {
  const { previous, nextHandIndices, strategy, actionCount } = args;
  if (nextHandIndices.length === 0 || actionCount <= 0) {
    return undefined;
  }
  const next: ComboProbsByHand = {};
  for (const handIndex of nextHandIndices) {
    const kept = previous?.[handIndex];
    if (
      kept &&
      kept.length === actionCount &&
      normalizeProbs(kept).valid
    ) {
      next[handIndex] = kept.slice();
      continue;
    }
    const row = strategy?.[handIndex];
    if (!row || row.length !== actionCount) {
      return undefined;
    }
    const normalized = normalizeProbs(row);
    if (!normalized.valid) {
      return undefined;
    }
    next[handIndex] = normalized.probs;
  }
  return next;
}

/**
 * Explicit full-range freeze payload: every legal combo keeps its own mix
 * (draft edits by identity win; otherwise published strategy).
 * Skips card-blocked / all-zero strategy rows so one blocked combo cannot
 * reject the whole Lock-all payload. Never a shared default 100%-first-action
 * row or a selected subset of only the current UI selection.
 */
export function buildFullRangeLockDraft(args: {
  strategy: number[][] | null | undefined;
  actionCount: number;
  handCount: number;
  existingByHand?: ComboProbsByHand | null;
}): LockDraft | null {
  const { strategy, actionCount, handCount, existingByHand } = args;
  if (handCount <= 0 || actionCount <= 0) {
    return null;
  }
  const byHand: ComboProbsByHand = {};
  const handIndices: number[] = [];
  for (let index = 0; index < handCount; index++) {
    const kept = existingByHand?.[index];
    if (
      kept &&
      kept.length === actionCount &&
      normalizeProbs(kept).valid
    ) {
      byHand[index] = kept.slice();
      handIndices.push(index);
      continue;
    }
    const row = strategy?.[index];
    if (!row || row.length !== actionCount) {
      continue;
    }
    const normalized = normalizeProbs(row);
    if (!normalized.valid) {
      // Blocked / no strategy slot on this board — skip, do not fail the node.
      continue;
    }
    byHand[index] = normalized.probs;
    handIndices.push(index);
  }
  if (handIndices.length === 0) {
    return null;
  }
  const rows = comboProbsRowsForHands(byHand, handIndices);
  if (!rows) {
    return null;
  }
  const probs = seedProbsFromStrategy(rows, handIndices.map((_, i) => i), actionCount);
  return {
    kind: "selected",
    handIndices,
    probs,
    comboProbsByHand: byHand,
  };
}

/** Apply-body shape for put_lock when freezing per-combo mixes. */
export function buildComboLockPutBody(args: {
  nodeId: string;
  scope: LockScope;
  handIndices: number[];
  comboProbsByHand: ComboProbsByHand;
  aggregateProbs: number[];
}): {
  node_id: string;
  kind: "selected";
  scope: LockScope;
  hand_indices: number[];
  probs: number[];
  combo_probs: number[][];
} | null {
  const rows = comboProbsRowsForHands(args.comboProbsByHand, args.handIndices);
  if (!rows || rows.length === 0) {
    return null;
  }
  for (const row of rows) {
    if (!normalizeProbs(row).valid) {
      return null;
    }
  }
  return {
    node_id: args.nodeId,
    kind: "selected",
    scope: args.scope,
    hand_indices: args.handIndices.slice(),
    probs: args.aggregateProbs.slice(),
    combo_probs: rows,
  };
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
 * in proportion to their previous shares. Fallback when EV-based cross-combo
 * reallocation is unavailable (single shared row / missing action EV).
 */
export function setLinkedActionProb(
  probs: number[],
  index: number,
  value: number,
  protectedActions?: boolean[],
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
  const isProtected = (actionIndex: number) =>
    actionIndex !== index && Boolean(protectedActions?.[actionIndex]);
  let protectedMass = 0;
  let movableOthers = 0;
  for (let actionIndex = 0; actionIndex < actionCount; actionIndex++) {
    if (actionIndex === index) {
      continue;
    }
    if (isProtected(actionIndex)) {
      protectedMass += next[actionIndex];
    } else {
      movableOthers += next[actionIndex];
    }
  }
  const maxTarget = Math.max(0, 1 - protectedMass);
  const clampedTarget = Math.min(target, maxTarget);
  const remaining = Math.max(0, 1 - clampedTarget - protectedMass);
  next[index] = clampedTarget;
  if (movableOthers > 1e-12) {
    for (let actionIndex = 0; actionIndex < actionCount; actionIndex++) {
      if (actionIndex === index || isProtected(actionIndex)) {
        continue;
      }
      next[actionIndex] = (next[actionIndex] / movableOthers) * remaining;
    }
  } else {
    const movableCount = actionCount - 1 - (protectedActions
      ? protectedActions.filter((flag, actionIndex) => flag && actionIndex !== index).length
      : 0);
    const each = movableCount > 0 ? remaining / movableCount : 0;
    for (let actionIndex = 0; actionIndex < actionCount; actionIndex++) {
      if (actionIndex === index || isProtected(actionIndex)) {
        continue;
      }
      next[actionIndex] = each;
    }
  }
  return next;
}

/** Default Pio near-tie band: 1% of pot when EV is pot-fraction. */
export const DEFAULT_NEAR_TIE_POT_FRACTION = 0.01;

export interface ReallocateByEvArgs {
  /** Per-combo mixes for the selected hands (parallel rows). */
  comboProbs: number[][];
  /** Per-combo action EV in the same units as `nearTieThreshold` (usually pot fraction). */
  actionEv: Array<Array<number | null | undefined>>;
  targetAction: number;
  /** Desired aggregate frequency of `targetAction` across the selected combos. */
  targetFreq: number;
  /** When true, that action is never a donor/recipient except as the moved target. */
  protectedActions?: boolean[];
  /** Equal weight when omitted; otherwise parallel to combo rows. */
  weights?: number[];
  /** Hands within this EV preference of the best are mixed together. */
  nearTieThreshold?: number;
}

export interface ReallocateByEvResult {
  comboProbs: number[][];
  /** Equal- or weight-averaged mix after reallocation. */
  aggregate: number[];
}

function finiteEv(row: Array<number | null | undefined> | undefined, action: number): number | null {
  const value = row?.[action];
  return Number.isFinite(value) ? Number(value) : null;
}

function comboCurrentEv(
  probs: number[],
  evRow: Array<number | null | undefined> | undefined,
): number | null {
  let sum = 0;
  let mass = 0;
  for (let action = 0; action < probs.length; action++) {
    const ev = finiteEv(evRow, action);
    const p = Math.max(0, probs[action] ?? 0);
    if (ev == null || !(p > 0)) {
      continue;
    }
    sum += p * ev;
    mass += p;
  }
  if (!(mass > 0)) {
    return null;
  }
  return sum / mass;
}

function aggregateComboProbs(
  comboProbs: number[][],
  actionCount: number,
  weights?: number[],
): number[] {
  const totals = emptyProbs(actionCount);
  let mass = 0;
  for (let rowIndex = 0; rowIndex < comboProbs.length; rowIndex++) {
    const row = comboProbs[rowIndex];
    if (!row || row.length !== actionCount) {
      continue;
    }
    const weight =
      weights && Number.isFinite(weights[rowIndex])
        ? Math.max(0, Number(weights[rowIndex]))
        : 1;
    if (!(weight > 0)) {
      continue;
    }
    mass += weight;
    for (let action = 0; action < actionCount; action++) {
      totals[action] += weight * Math.max(0, Number(row[action]) || 0);
    }
  }
  if (!(mass > 0)) {
    return uniformProbs(actionCount);
  }
  return totals.map((value) => value / mass);
}

/**
 * Move `amount` probability mass onto `targetAction` within one combo row,
 * taking from unprotected non-target actions. Prefer sources with the smallest
 * EV loss (near-ties mixed). Returns mass actually moved.
 */
function takeMassTowardAction(
  probs: number[],
  evRow: Array<number | null | undefined> | undefined,
  targetAction: number,
  amount: number,
  protectedActions: boolean[] | undefined,
  nearTieThreshold: number,
): number {
  if (!(amount > 1e-15)) {
    return 0;
  }
  const targetEv = finiteEv(evRow, targetAction);
  const sources: number[] = [];
  for (let action = 0; action < probs.length; action++) {
    if (action === targetAction || protectedActions?.[action]) {
      continue;
    }
    if (probs[action] > 1e-15) {
      sources.push(action);
    }
  }
  if (sources.length === 0) {
    return 0;
  }
  let moved = 0;
  let remaining = amount;
  // Drain in near-tie preference cohorts (lowest EV loss first).
  while (remaining > 1e-15 && sources.some((action) => probs[action] > 1e-15)) {
    let bestLoss = Number.POSITIVE_INFINITY;
    for (const action of sources) {
      if (!(probs[action] > 1e-15)) {
        continue;
      }
      const sourceEv = finiteEv(evRow, action);
      const loss =
        targetEv != null && sourceEv != null ? sourceEv - targetEv : 0;
      if (loss < bestLoss) {
        bestLoss = loss;
      }
    }
    const cohort = sources.filter((action) => {
      if (!(probs[action] > 1e-15)) {
        return false;
      }
      const sourceEv = finiteEv(evRow, action);
      const loss =
        targetEv != null && sourceEv != null ? sourceEv - targetEv : 0;
      return loss <= bestLoss + nearTieThreshold + 1e-15;
    });
    const cohortMass = cohort.reduce((sum, action) => sum + probs[action], 0);
    if (!(cohortMass > 1e-15)) {
      break;
    }
    const take = Math.min(remaining, cohortMass);
    for (const action of cohort) {
      const share = probs[action] / cohortMass;
      const delta = take * share;
      probs[action] -= delta;
      probs[targetAction] += delta;
      moved += delta;
      remaining -= delta;
    }
  }
  return moved;
}

/**
 * Move `amount` probability mass off `targetAction` onto unprotected alternatives,
 * preferring highest-EV destinations (near-ties mixed).
 */
function giveMassFromAction(
  probs: number[],
  evRow: Array<number | null | undefined> | undefined,
  targetAction: number,
  amount: number,
  protectedActions: boolean[] | undefined,
  nearTieThreshold: number,
): number {
  if (!(amount > 1e-15) || !(probs[targetAction] > 1e-15)) {
    return 0;
  }
  const destinations: number[] = [];
  for (let action = 0; action < probs.length; action++) {
    if (action === targetAction || protectedActions?.[action]) {
      continue;
    }
    destinations.push(action);
  }
  if (destinations.length === 0) {
    return 0;
  }
  const take = Math.min(amount, probs[targetAction]);
  let bestEv = Number.NEGATIVE_INFINITY;
  let anyEv = false;
  for (const action of destinations) {
    const ev = finiteEv(evRow, action);
    if (ev == null) {
      continue;
    }
    anyEv = true;
    if (ev > bestEv) {
      bestEv = ev;
    }
  }
  const cohort = destinations.filter((action) => {
    if (!anyEv) {
      return true;
    }
    const ev = finiteEv(evRow, action);
    if (ev == null) {
      return false;
    }
    return ev >= bestEv - nearTieThreshold - 1e-15;
  });
  if (cohort.length === 0) {
    return 0;
  }
  const each = take / cohort.length;
  probs[targetAction] -= take;
  for (const action of cohort) {
    probs[action] += each;
  }
  return take;
}

/**
 * Pio-style frequency sliders: reallocate strategy **across combos** so the
 * selected aggregate frequency of `targetAction` approaches `targetFreq`.
 *
 * Preference for adding action A on a hand is `EV(A) - currentEV`. Hands within
 * `nearTieThreshold` of the best preference share the move (mixed), instead of
 * dumping the entire delta onto one combo. Protected actions keep their mass
 * except when they are the slider being moved.
 *
 * Locking stays separate: this only edits draft strategy rows.
 */
export function reallocateComboStrategiesByEv(
  args: ReallocateByEvArgs,
): ReallocateByEvResult {
  const actionCount = args.comboProbs[0]?.length ?? 0;
  const rows = args.comboProbs.map((row) =>
    row.map((value) => (Number.isFinite(value) && value >= 0 ? value : 0)),
  );
  if (
    rows.length === 0 ||
    actionCount <= 0 ||
    args.targetAction < 0 ||
    args.targetAction >= actionCount
  ) {
    return {
      comboProbs: rows,
      aggregate: aggregateComboProbs(rows, actionCount, args.weights),
    };
  }

  const threshold =
    Number.isFinite(args.nearTieThreshold) && (args.nearTieThreshold as number) >= 0
      ? (args.nearTieThreshold as number)
      : DEFAULT_NEAR_TIE_POT_FRACTION;
  const targetFreq = Math.max(0, Math.min(1, Number.isFinite(args.targetFreq) ? args.targetFreq : 0));
  const weights = rows.map((_, index) => {
    const weight = args.weights?.[index];
    return Number.isFinite(weight) ? Math.max(0, Number(weight)) : 1;
  });
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (!(totalWeight > 0)) {
    return {
      comboProbs: rows,
      aggregate: aggregateComboProbs(rows, actionCount, weights),
    };
  }

  const currentAgg = aggregateComboProbs(rows, actionCount, weights);
  const deltaFreq = targetFreq - currentAgg[args.targetAction];
  // Mass in weight×probability units.
  let remainingMass = deltaFreq * totalWeight;
  const increasing = remainingMass > 0;
  remainingMass = Math.abs(remainingMass);

  // Iterative near-tie cohorts (Pio mixes hands whose preference is close).
  for (let iter = 0; iter < 64 && remainingMass > 1e-12; iter++) {
    type Candidate = {
      index: number;
      preference: number;
      capacity: number;
    };
    const candidates: Candidate[] = [];
    for (let index = 0; index < rows.length; index++) {
      const weight = weights[index];
      if (!(weight > 0)) {
        continue;
      }
      const probs = rows[index];
      const evRow = args.actionEv[index];
      const currentEv = comboCurrentEv(probs, evRow);
      const targetEv = finiteEv(evRow, args.targetAction);
      // Missing EV → neutral preference so the hand still participates in ties.
      const preference =
        currentEv != null && targetEv != null ? targetEv - currentEv : 0;

      let capacityProb = 0;
      if (increasing) {
        for (let action = 0; action < actionCount; action++) {
          if (action === args.targetAction || args.protectedActions?.[action]) {
            continue;
          }
          capacityProb += probs[action];
        }
      } else {
        capacityProb = probs[args.targetAction];
        // Cannot move off target if every destination is protected.
        let hasDest = false;
        for (let action = 0; action < actionCount; action++) {
          if (action !== args.targetAction && !args.protectedActions?.[action]) {
            hasDest = true;
            break;
          }
        }
        if (!hasDest) {
          capacityProb = 0;
        }
      }
      const capacity = capacityProb * weight;
      if (capacity > 1e-15) {
        candidates.push({ index, preference, capacity });
      }
    }
    if (candidates.length === 0) {
      break;
    }

    let bestPreference = increasing
      ? Number.NEGATIVE_INFINITY
      : Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      if (increasing) {
        if (candidate.preference > bestPreference) {
          bestPreference = candidate.preference;
        }
      } else if (candidate.preference < bestPreference) {
        bestPreference = candidate.preference;
      }
    }
    const cohort = candidates.filter((candidate) =>
      increasing
        ? candidate.preference >= bestPreference - threshold - 1e-15
        : candidate.preference <= bestPreference + threshold + 1e-15,
    );
    const cohortCapacity = cohort.reduce((sum, candidate) => sum + candidate.capacity, 0);
    if (!(cohortCapacity > 1e-15)) {
      break;
    }
    const batch = Math.min(remainingMass, cohortCapacity);
    for (const candidate of cohort) {
      const share = candidate.capacity / cohortCapacity;
      const massForHand = batch * share;
      const probDelta = massForHand / weights[candidate.index];
      const moved = increasing
        ? takeMassTowardAction(
            rows[candidate.index],
            args.actionEv[candidate.index],
            args.targetAction,
            probDelta,
            args.protectedActions,
            threshold,
          )
        : giveMassFromAction(
            rows[candidate.index],
            args.actionEv[candidate.index],
            args.targetAction,
            probDelta,
            args.protectedActions,
            threshold,
          );
      remainingMass -= moved * weights[candidate.index];
    }
  }

  // Renormalize each row against floating error while preserving protected mass shape.
  for (let index = 0; index < rows.length; index++) {
    const normalized = normalizeProbs(rows[index]);
    if (normalized.valid) {
      rows[index] = normalized.probs;
    }
  }

  return {
    comboProbs: rows,
    aggregate: aggregateComboProbs(rows, actionCount, weights),
  };
}

/**
 * Apply a linked frequency edit to per-combo draft rows.
 * Uses EV prefs when `actionEv` is present; otherwise all hands share a neutral
 * preference so mass still moves across combos toward the aggregate target
 * (never flattens every row to one shared mix).
 */
export function applyFrequencySliderEdit(args: {
  comboProbs: number[][];
  actionEv?: Array<Array<number | null | undefined>> | null;
  targetAction: number;
  targetFreq: number;
  protectedActions?: boolean[];
  weights?: number[];
  nearTieThreshold?: number;
}): ReallocateByEvResult {
  const actionCount = args.comboProbs[0]?.length ?? 0;
  const actionEv =
    Array.isArray(args.actionEv) && args.actionEv.length === args.comboProbs.length
      ? args.actionEv
      : args.comboProbs.map(() => Array.from({ length: actionCount }, () => null));
  return reallocateComboStrategiesByEv({
    comboProbs: args.comboProbs,
    actionEv,
    targetAction: args.targetAction,
    targetFreq: args.targetFreq,
    protectedActions: args.protectedActions,
    weights: args.weights,
    nearTieThreshold: args.nearTieThreshold,
  });
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

/** True when the open lock draft differs from the last applied baseline. */
export function lockDraftIsDirty(
  draft: LockDraft | null | undefined,
  baseline: LockDraft | null | undefined,
): boolean {
  if (!draft) {
    return false;
  }
  if (!baseline) {
    return (
      draft.handIndices.length > 0 ||
      draft.kind === "full" ||
      Boolean(draft.comboProbsByHand)
    );
  }
  if (draft.kind !== baseline.kind) {
    return true;
  }
  if (draft.handIndices.length !== baseline.handIndices.length) {
    return true;
  }
  for (let i = 0; i < draft.handIndices.length; i++) {
    if (draft.handIndices[i] !== baseline.handIndices[i]) {
      return true;
    }
  }
  if (!probsNearlyEqual(draft.probs, baseline.probs)) {
    return true;
  }
  const left = draft.comboProbsByHand;
  const right = baseline.comboProbsByHand;
  if (!left && !right) {
    return false;
  }
  if (!left || !right) {
    return true;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return true;
  }
  for (const key of leftKeys) {
    const row = left[Number(key)];
    const other = right[Number(key)];
    if (!row || !other || !probsNearlyEqual(row, other)) {
      return true;
    }
  }
  return false;
}

/** Combos the commit buttons will affect. */
export function lockAffectedComboCount(
  draft: LockDraft,
  totalHands: number,
): number {
  if (draft.kind === "full") {
    if (draft.comboProbsByHand) {
      return Object.keys(draft.comboProbsByHand).length;
    }
    return Math.max(0, totalHands);
  }
  return draft.handIndices.length;
}

/**
 * Range-wide action aggregates. Prefers host `action_summary`; otherwise
 * weights each strategy by its own per-hand weights (or equal weight).
 */
export function compareActionAggregates(
  note: ComparePayload,
): CompareActionSummary[] {
  if (Array.isArray(note.action_summary) && note.action_summary.length > 0) {
    return note.action_summary.map((row) => ({
      action: row.action,
      baseline: Number(row.baseline) || 0,
      scenario: Number(row.scenario) || 0,
      delta: Number(row.delta) || 0,
    }));
  }
  const actions = note.actions ?? [];
  if (actions.length === 0) {
    return [];
  }
  const baseTotals = emptyProbs(actions.length);
  const scenTotals = emptyProbs(actions.length);
  let baseMass = 0;
  let scenMass = 0;
  for (const hand of note.hands ?? []) {
    const bw =
      hand.baseline_weight != null && Number.isFinite(hand.baseline_weight)
        ? Math.max(0, Number(hand.baseline_weight))
        : 1;
    const sw =
      hand.scenario_weight != null && Number.isFinite(hand.scenario_weight)
        ? Math.max(0, Number(hand.scenario_weight))
        : 1;
    if (bw > 0 && Array.isArray(hand.baseline)) {
      baseMass += bw;
      hand.baseline.forEach((p, i) => {
        if (i < baseTotals.length) {
          baseTotals[i]! += bw * Math.max(0, Number(p) || 0);
        }
      });
    }
    if (sw > 0 && Array.isArray(hand.scenario)) {
      scenMass += sw;
      hand.scenario.forEach((p, i) => {
        if (i < scenTotals.length) {
          scenTotals[i]! += sw * Math.max(0, Number(p) || 0);
        }
      });
    }
  }
  return actions.map((action, i) => {
    const baseline = baseMass > 0 ? baseTotals[i]! / baseMass : 0;
    const scenario = scenMass > 0 ? scenTotals[i]! / scenMass : 0;
    return { action, baseline, scenario, delta: scenario - baseline };
  });
}

/** Short readable change line from action aggregates (largest |Δ| first). */
export function compareChangeDescription(
  summary: CompareActionSummary[],
  limit = 3,
): string {
  const ranked = [...summary]
    .filter((row) => Number.isFinite(row.delta) && Math.abs(row.delta) >= 0.0005)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, limit);
  if (ranked.length === 0) {
    return "No material frequency change";
  }
  return ranked
    .map((row) => {
      const pp = row.delta * 100;
      const sign = pp > 0 ? "+" : "";
      return `${row.action} ${sign}${pp.toFixed(1)}pp`;
    })
    .join(" · ");
}

export function formatCompareBoard(
  board: string[] | string | null | undefined,
): string {
  if (!board) {
    return "—";
  }
  if (typeof board === "string") {
    return board.trim() || "—";
  }
  return board.filter(Boolean).join(" ") || "—";
}

export function compareActorLabel(
  player: number | null | undefined,
): string {
  if (player === 0) {
    return "OOP";
  }
  if (player === 1) {
    return "IP";
  }
  return "—";
}
