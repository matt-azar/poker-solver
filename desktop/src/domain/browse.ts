import { canonicalizeCombo } from "./range";
import type {
  ActionValuesPayload,
  EvDisplayBasis,
  FrequencyMode,
  GroupEv,
  HandCell,
  NodePayload,
} from "./types";
import { RANKS } from "./types";

/** Normalize a 4-char combo so node/values suit-order variants still match. */
function comboKey(combo: string): string {
  if (combo.length < 4) {
    return combo;
  }
  try {
    return canonicalizeCombo(combo.slice(0, 2), combo.slice(2, 4));
  } catch {
    return combo;
  }
}

export function foldActionIndex(actions: string[] | null | undefined): number {
  if (!actions) {
    return -1;
  }
  return actions.findIndex((label) => label === "Fold");
}

/**
 * Baseline to subtract from root-centered chips for local decision EV.
 * Prefer the Fold column when present (Fold → 0 even with path incentives).
 * Otherwise use -local_offset so local = root + local_offset per /values docs.
 * action_ev columns follow values.actions; prefer that list over node labels.
 */
function localEvBaseline(
  values: ActionValuesPayload,
  hand: number,
  actionLabels?: string[] | null,
): number {
  const actions =
    values.actions && values.actions.length > 0
      ? values.actions
      : actionLabels || [];
  const foldIdx = foldActionIndex(actions);
  const offset = Number(values.local_offset ?? 0);
  const offsetBaseline = Number.isFinite(offset) ? -offset : 0;
  if (foldIdx < 0) {
    return offsetBaseline;
  }
  const row = values.action_ev?.[hand];
  if (!row) {
    return offsetBaseline;
  }
  const foldEv = Number(row[foldIdx] ?? NaN);
  return Number.isFinite(foldEv) ? foldEv : offsetBaseline;
}

/**
 * Map action values onto the requested display basis.
 *
 * Zig `values` ships local decision EV as primary (`utility_basis: "local"`,
 * Fold≈0) plus dual `root_centered` columns for Settings Global without refetch.
 * Legacy root-only payloads still shift via local_offset / Fold baseline.
 */
export function withEvBasis(
  values: ActionValuesPayload | null | undefined,
  basis: EvDisplayBasis = "local",
  actionLabels?: string[] | null,
): ActionValuesPayload | null | undefined {
  if (!values || values.pending) {
    return values;
  }
  const engineBasis =
    values.utility_basis === "local" ? "local" : "root_centered";
  if (basis === engineBasis) {
    return values;
  }

  // Zig dual columns: flip to root without reverse-shifting local numbers.
  if (basis === "root_centered" && engineBasis === "local") {
    const root = values.root_centered;
    if (root && (root.action_ev || root.value || root.node_ev !== undefined)) {
      return {
        ...values,
        utility_basis: "root_centered",
        action_ev: root.action_ev ?? values.action_ev,
        value: root.value ?? values.value,
        node_ev: root.node_ev ?? values.node_ev ?? null,
      };
    }
    // Fallback: reverse local_offset when dual columns are absent.
    const offset = Number(values.local_offset ?? 0);
    const shift = Number.isFinite(offset) ? offset : 0;
    const actionEv = (values.action_ev || []).map((row, hand) => {
      if (!row || !values.ev_defined?.[hand]) {
        return row;
      }
      return row.map((entry) =>
        entry == null || Number.isNaN(Number(entry))
          ? entry
          : Number(entry) - shift,
      );
    });
    const mixed = (values.value || []).map((entry, hand) => {
      if (
        !values.ev_defined?.[hand] ||
        entry == null ||
        Number.isNaN(Number(entry))
      ) {
        return entry;
      }
      return Number(entry) - shift;
    });
    const nodeEv =
      values.node_ev == null || Number.isNaN(Number(values.node_ev))
        ? values.node_ev
        : Number(values.node_ev) - shift;
    return {
      ...values,
      utility_basis: "root_centered",
      action_ev: actionEv,
      value: mixed,
      node_ev: nodeEv ?? null,
    };
  }

  // Legacy root_centered primary → local via Fold baseline / local_offset.
  const offset = Number(values.local_offset ?? 0);
  const shift = Number.isFinite(offset) ? offset : 0;
  const actionEv = (values.action_ev || []).map((row, hand) => {
    if (!row || !values.ev_defined?.[hand]) {
      return row;
    }
    const baseline = localEvBaseline(values, hand, actionLabels);
    return row.map((entry) =>
      entry == null || Number.isNaN(Number(entry))
        ? entry
        : Number(entry) - baseline,
    );
  });
  const mixed = (values.value || []).map((entry, hand) => {
    if (!values.ev_defined?.[hand] || entry == null || Number.isNaN(Number(entry))) {
      return entry;
    }
    const baseline = localEvBaseline(values, hand, actionLabels);
    return Number(entry) - baseline;
  });
  const nodeEv =
    values.node_ev == null || Number.isNaN(Number(values.node_ev))
      ? values.node_ev
      : Number(values.node_ev) + shift;
  return {
    ...values,
    utility_basis: "local",
    action_ev: actionEv,
    value: mixed,
    node_ev: nodeEv ?? null,
  };
}

export function isAggressive(label: string): boolean {
  return label.startsWith("Bet") || label.startsWith("Raise");
}

export function frequencyOptions(
  node: Pick<NodePayload, "actions">,
): Array<{ id: FrequencyMode; label: string }> {
  const options: Array<{ id: FrequencyMode; label: string }> = [
    { id: "aggression", label: "Bet or raise" },
  ];
  (node.actions || []).forEach((label, index) => {
    options.push({ id: String(index) as FrequencyMode, label });
  });
  return options;
}

export function shouldApply(
  token: number,
  nodeToken: number,
  solution: string | null | undefined,
  solutionId: string | null | undefined,
): boolean {
  return (
    token === nodeToken &&
    solution != null &&
    solutionId != null &&
    solution === solutionId
  );
}

/**
 * Token + solution (+ optional node) gate for post-await UI writes.
 * When `requestNodeId` is provided, a live node mismatch fails closed.
 */
export function shouldApplyScoped(args: {
  token: number;
  latestToken: number;
  requestSolutionId: string | null | undefined;
  liveSolutionId: string | null | undefined;
  requestNodeId?: string | null;
  liveNodeId?: string | null;
}): boolean {
  if (
    !shouldApply(
      args.token,
      args.latestToken,
      args.requestSolutionId,
      args.liveSolutionId,
    )
  ) {
    return false;
  }
  if (
    args.requestNodeId != null &&
    args.requestNodeId !== "" &&
    (args.liveNodeId == null || args.requestNodeId !== args.liveNodeId)
  ) {
    return false;
  }
  return true;
}

/**
 * Monotonic status-generation gate.
 * Returns null when the body is missing a generation or is strictly older than
 * `seen` (stale / out-of-order). Callers must not mutate study state on null.
 *
 * Engine restarts reset the counter; use {@link acceptStatusGeneration} after a
 * request-token check so a lower generation on the latest in-flight response
 * can re-baseline instead of being stuck rejecting forever.
 */
export function nextGeneration(
  body: { status_generation?: number },
  seen: number,
): number | null {
  if (typeof body.status_generation !== "number" || body.status_generation < seen) {
    return null;
  }
  return body.status_generation;
}

export type StatusGenerationDecision =
  | { apply: true; generation: number; restarted: boolean }
  | { apply: false; reason: "missing" | "stale" };

/**
 * Decide whether a status body may update store state.
 *
 * `allowRestart` should be true only for the latest status request token: a
 * lower generation on that response means the explorer process restarted, not
 * an overlapping stale poll (those are dropped by the token).
 */
export function acceptStatusGeneration(
  body: { status_generation?: number },
  seen: number,
  options?: { allowRestart?: boolean },
): StatusGenerationDecision {
  if (typeof body.status_generation !== "number") {
    return { apply: false, reason: "missing" };
  }
  const generation = body.status_generation;
  if (generation >= seen) {
    return { apply: true, generation, restarted: false };
  }
  if (options?.allowRestart) {
    return { apply: true, generation, restarted: true };
  }
  return { apply: false, reason: "stale" };
}

/** True when a status poll token still matches the latest issued request. */
export function shouldApplyStatus(
  token: number,
  statusToken: number,
): boolean {
  return token === statusToken;
}

export function solutionNeedsReload(
  status: { running?: boolean; solution_id?: string | null } | null | undefined,
  solutionId: string | null | undefined,
  continuationPending: boolean,
): boolean {
  if (!status || status.running || !status.solution_id) {
    return false;
  }
  return status.solution_id !== solutionId || continuationPending === true;
}

/**
 * Hand cell with engine reach aggregated for Range-mode inclusion display.
 * Strategy / EV helpers keep using posterior {@link HandCell.marginalSum}.
 */
export type AggregatedHandCell = HandCell & {
  /** Sum of pre-posterior reach across combos present in this 169-cell. */
  reachSum: number;
};

function nodeReach(node: NodePayload): number[] | null {
  const reach = node.reach;
  return Array.isArray(reach) ? (reach as number[]) : null;
}

export function groupHands(node: NodePayload): AggregatedHandCell[] {
  const cells = new Map<string, AggregatedHandCell>();
  const reach = nodeReach(node);
  (node.combos || []).forEach((combo, index) => {
    const high = RANKS.indexOf(combo[0] as (typeof RANKS)[number]);
    const low = RANKS.indexOf(combo[2] as (typeof RANKS)[number]);
    const suited = combo[1] === combo[3];
    let row = high;
    let column = low;
    if (combo[0] !== combo[2] && suited) {
      row = Math.min(high, low);
      column = Math.max(high, low);
    } else if (combo[0] !== combo[2]) {
      row = Math.max(high, low);
      column = Math.min(high, low);
    }
    const key = `${row}:${column}`;
    if (!cells.has(key)) {
      const text =
        combo[0] === combo[2]
          ? `${RANKS[row]}${RANKS[column]}`
          : row < column
            ? `${RANKS[row]}${RANKS[column]}s`
            : `${RANKS[column]}${RANKS[row]}o`;
      cells.set(key, {
        row,
        col: column,
        text,
        hands: [],
        range_combos: 0,
        marginalSum: 0,
        reachSum: 0,
        actionMass: (node.actions || []).map(() => 0),
        aggressionMass: 0,
        defined: !!node.reach_defined,
      });
    }
    const cell = cells.get(key)!;
    const strategy = node.strategy ? node.strategy[index] : null;
    const marginal = node.reach_defined ? Number(node.marginal?.[index] ?? 0) : 0;
    const handReach = node.reach_defined ? Number(reach?.[index] ?? 0) : 0;
    const actions = strategy
      ? (node.actions || []).map((action, actionIndex) => ({
          action,
          probability: strategy[actionIndex],
        }))
      : [];
    cell.hands.push({ combo, actions });
    cell.range_combos = cell.hands.length;
    if (!node.reach_defined) {
      return;
    }
    cell.marginalSum += marginal;
    cell.reachSum += handReach;
    if (!strategy) {
      return;
    }
    strategy.forEach((probability, actionIndex) => {
      cell.actionMass[actionIndex] += marginal * probability;
      if (isAggressive((node.actions || [])[actionIndex] || "")) {
        cell.aggressionMass += marginal * probability;
      }
    });
  });
  return [...cells.values()];
}

/** Human-readable name for Range-mode cell numbers (not average posterior). */
export const RANGE_INCLUSION_MEASURE = "inclusion weight";

/**
 * Immutable non-acting seat snapshot for dual-range Study view.
 * Maps solution `opponent_*` fields onto the acting-seat NodePayload shape so
 * {@link groupHands} / {@link rangeInclusionOf} reuse the same inclusion math.
 * Never reads Build draft weights.
 */
export function opponentSolutionNode(
  node: NodePayload | null | undefined,
): NodePayload | null {
  if (!node || node.opponent_player == null) {
    return null;
  }
  const combos = node.opponent_combos;
  if (!combos?.length) {
    return null;
  }
  const reach = Array.isArray(node.opponent_reach) ? node.opponent_reach : null;
  if (!reach || reach.length !== combos.length) {
    return null;
  }
  const marginal = Array.isArray(node.opponent_marginal)
    ? node.opponent_marginal
    : undefined;
  return {
    node_id: node.node_id,
    kind: node.kind,
    player: node.opponent_player,
    // Opponent inclusion is defined whenever solution opponent_reach is present.
    reach_defined: true,
    combos,
    reach,
    marginal,
    actions: [],
  };
}

/**
 * Conventional range inclusion for a 169-cell: mean engine reach across the
 * combos listed for that class. Uses reach, not normalized posterior marginal.
 */
export function rangeInclusionOf(cell: AggregatedHandCell | HandCell): number | null {
  const reachSum =
    "reachSum" in cell && typeof cell.reachSum === "number" ? cell.reachSum : null;
  if (!cell.defined || cell.range_combos <= 0 || reachSum == null) {
    return null;
  }
  if (!(reachSum > 0)) {
    return 0;
  }
  return Math.min(1, reachSum / cell.range_combos);
}

export function formatRangeInclusion(weight: number): string {
  return `${(weight * 100).toFixed(0)}`;
}

export function frequencyOf(cell: HandCell, mode: FrequencyMode): number | null {
  if (!cell.defined || cell.marginalSum === 0) {
    return null;
  }
  if (mode === "aggression") {
    return cell.aggressionMass / cell.marginalSum;
  }
  return cell.actionMass[Number(mode)] / cell.marginalSum;
}

/**
 * Same ratio Range mode paints today: average posterior mass per listed combo.
 * Not conventional range inclusion (reach); do not label it as inclusion.
 */
export function rangeDisplayWeight(cell: HandCell): number | null {
  if (!cell.defined || cell.range_combos <= 0) {
    return null;
  }
  if (!(cell.marginalSum > 0)) {
    return 0;
  }
  return Math.min(1, cell.marginalSum / cell.range_combos);
}

/** Zero-mass / undefined hand class — matrix density treats these as excluded. */
export function isExcludedMatrixCell(
  cell: HandCell | null | undefined,
): boolean {
  return !cell || !cell.defined || !(cell.marginalSum > 0);
}

/**
 * Visual-only flag: displayed range weight is strictly between empty and full.
 * Does not change numerical semantics; another path owns true inclusion math.
 */
export function isPartialRangeDisplay(cell: HandCell): boolean {
  const weight = rangeDisplayWeight(cell);
  return weight != null && weight > 1e-6 && weight < 1 - 1e-6;
}

/** Visual-only: two or more actions carry meaningful posterior mass. */
export function hasWithinHandActionMixing(cell: HandCell): boolean {
  const mix = strategyMix(cell);
  if (!mix) {
    return false;
  }
  let positive = 0;
  for (const weight of mix) {
    if (weight > 1e-3) {
      positive += 1;
      if (positive > 1) {
        return true;
      }
    }
  }
  return false;
}

/** Prefer Zig `cell_ev` aggregates for the requested display basis. */
function zigCellEv(
  values: ActionValuesPayload,
  basis: EvDisplayBasis,
  cell: HandCell,
): GroupEv | null | undefined {
  const list =
    basis === "root_centered"
      ? values.root_centered?.cell_ev
      : values.cell_ev;
  // undefined → caller falls back to client join; null → empty cell.
  if (!list) {
    return undefined;
  }
  for (const entry of list) {
    if (entry.row === cell.row && entry.col === cell.col) {
      return {
        mixed: Number(entry.mixed),
        action: (entry.action || []).map((v) => Number(v)),
      };
    }
  }
  return null;
}

/** Posterior-weighted. Zero-mass groups stay null even when CF values exist. */
export function groupEv(
  node: NodePayload | null | undefined,
  values: ActionValuesPayload | null | undefined,
  cell: HandCell | null | undefined,
  basis: EvDisplayBasis = "local",
): GroupEv | null {
  if (!node || !node.reach_defined || !values || values.pending || !cell) {
    return null;
  }
  if (values.node_id && node.node_id && values.node_id !== node.node_id) {
    return null;
  }

  // Zig 169-cell aggregates kill the per-cell findIndex hotspot on matrix paint.
  const fromZig = zigCellEv(values, basis, cell);
  if (fromZig !== undefined) {
    return fromZig;
  }

  const displayed = withEvBasis(values, basis, node?.actions);
  if (!displayed || displayed.pending) {
    return null;
  }
  const combos = displayed.combos || node.combos || [];
  let mass = 0;
  let mixed = 0;
  const action = (node.actions || []).map(() => 0);
  for (const hand of cell.hands || []) {
    const key = comboKey(hand.combo);
    const nodeIndex = (node.combos || []).findIndex(
      (entry) => comboKey(entry) === key,
    );
    const valueIndex = combos.findIndex((entry) => comboKey(entry) === key);
    if (nodeIndex < 0 || valueIndex < 0) {
      continue;
    }
    const marginal = Number(node.marginal?.[nodeIndex] ?? 0);
    if (!(marginal > 0)) {
      continue;
    }
    if (!displayed.ev_defined || !displayed.ev_defined[valueIndex]) {
      return null;
    }
    const row = displayed.action_ev?.[valueIndex] || [];
    mass += marginal;
    mixed += marginal * Number(displayed.value?.[valueIndex] ?? 0);
    action.forEach((_, index) => {
      action[index] += marginal * Number(row[index] ?? 0);
    });
  }
  if (!(mass > 0)) {
    return null;
  }
  return {
    mixed: mixed / mass,
    action: action.map((entry) => entry / mass),
  };
}

export function strategyMix(cell: HandCell): number[] | null {
  if (!cell.defined || cell.marginalSum <= 0 || cell.actionMass.length === 0) {
    return null;
  }
  return cell.actionMass.map((mass) => mass / cell.marginalSum);
}
