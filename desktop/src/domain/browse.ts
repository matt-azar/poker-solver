import type {
  ActionValuesPayload,
  FrequencyMode,
  GroupEv,
  HandCell,
  NodePayload,
} from "./types";
import { RANKS } from "./types";

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
  return token === nodeToken && solution === solutionId;
}

export function nextGeneration(
  body: { status_generation?: number },
  seen: number,
): number | null {
  if (typeof body.status_generation !== "number" || body.status_generation < seen) {
    return null;
  }
  return body.status_generation;
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

export function groupHands(node: NodePayload): HandCell[] {
  const cells = new Map<string, HandCell>();
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
        actionMass: (node.actions || []).map(() => 0),
        aggressionMass: 0,
        defined: !!node.reach_defined,
      });
    }
    const cell = cells.get(key)!;
    const strategy = node.strategy ? node.strategy[index] : null;
    const marginal = node.reach_defined ? Number(node.marginal?.[index] ?? 0) : 0;
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

export function frequencyOf(cell: HandCell, mode: FrequencyMode): number | null {
  if (!cell.defined || cell.marginalSum === 0) {
    return null;
  }
  if (mode === "aggression") {
    return cell.aggressionMass / cell.marginalSum;
  }
  return cell.actionMass[Number(mode)] / cell.marginalSum;
}

/** Posterior-weighted. Zero-mass groups stay null even when CF values exist. */
export function groupEv(
  node: NodePayload | null | undefined,
  values: ActionValuesPayload | null | undefined,
  cell: HandCell | null | undefined,
): GroupEv | null {
  if (!node || !node.reach_defined || !values || values.pending || !cell) {
    return null;
  }
  if (values.node_id && node.node_id && values.node_id !== node.node_id) {
    return null;
  }
  const combos = values.combos || node.combos || [];
  let mass = 0;
  let mixed = 0;
  const action = (node.actions || []).map(() => 0);
  for (const hand of cell.hands || []) {
    const nodeIndex = (node.combos || []).indexOf(hand.combo);
    const valueIndex = combos.indexOf(hand.combo);
    if (nodeIndex < 0 || valueIndex < 0) {
      continue;
    }
    const marginal = Number(node.marginal?.[nodeIndex] ?? 0);
    if (!(marginal > 0)) {
      continue;
    }
    if (!values.ev_defined || !values.ev_defined[valueIndex]) {
      return null;
    }
    const row = values.action_ev?.[valueIndex] || [];
    mass += marginal;
    mixed += marginal * Number(values.value?.[valueIndex] ?? 0);
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
