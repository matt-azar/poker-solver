/**
 * Same-line card comparison: one betting decision across turn/river cards.
 *
 * Line identity is the public betting index (compact `pN…` id) plus a card
 * street to vary. Deal probability and node reach stay separate quantities.
 */
import {
  CARD_RANKS,
  CARD_SUITS,
  chanceCardOptions,
  linePreservingCardTargetId,
  normalizeBoardCards,
  type CardRank,
  type CardSuit,
  type ChanceCardOption,
  type DealStreet,
} from "./cards";
import { strategyFrequencies } from "./actionHistory";
import { withEvBasis } from "./browse";
import type { ActionValuesPayload, EvDisplayBasis, NodePayload } from "./types";

/** Compare-cards grid: rank 2 on the left through ace on the right. */
export const LINE_CARD_GRID_RANKS: readonly CardRank[] = [...CARD_RANKS].reverse();
export const LINE_CARD_GRID_SUITS: readonly CardSuit[] = CARD_SUITS;

export type LineCardMetric = "frequencies" | "ev" | "equity" | "deal";

export type LineCardVaryStreet = "turn" | "river";

export interface LineCardReportRow {
  card: string;
  /** Weight of dealing this card at the chance node (null when undefined). */
  dealProbability: number | null;
  dealProbabilityDefined: boolean;
  /** Acting-seat joint / reach mass at the resolved decision (`joint`). */
  reach: number | null;
  reachDefined: boolean;
  /** True when joint reach is present and exactly 0. */
  zeroReach: boolean;
  available: boolean;
  reason: string | null;
  resolvedNodeId: string | null;
  actions: string[];
  /** Posterior-marginal action mix at the resolved node (empty if unavailable). */
  frequencies: number[];
  /** Acting seat at the resolved decision (0 OOP / 1 IP), when known. */
  player?: number | null;
  /** Acting-player node EV in chips under the study display basis. */
  ev?: number | null;
  evDefined?: boolean;
  /** Acting-player check-down equity as a fraction of the pot. */
  equity?: number | null;
  equityDefined?: boolean;
}

export interface LineCardReportModel {
  pending: boolean;
  error?: string;
  reportNodeId: string;
  line: string;
  street: LineCardVaryStreet;
  chanceNodeId: string;
  actionLabels: string[];
  rows: LineCardReportRow[];
  solutionId?: string;
}

/** Which card street a same-line report can vary from the current board. */
export function lineCardReportStreet(
  board: string[] | string | null | undefined,
): LineCardVaryStreet | null {
  const len = normalizeBoardCards(board).length;
  if (len >= 5) {
    return "river";
  }
  if (len >= 4) {
    return "turn";
  }
  return null;
}

export function readNodeJoint(node: NodePayload | null | undefined): {
  reach: number | null;
  reachDefined: boolean;
  zeroReach: boolean;
} {
  const raw = node?.joint;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { reach: null, reachDefined: false, zeroReach: false };
  }
  return {
    reach: raw,
    reachDefined: true,
    zeroReach: raw === 0,
  };
}

export function unavailableRow(
  option: ChanceCardOption,
  reason: string,
): LineCardReportRow {
  return {
    card: option.card,
    dealProbability: option.weight,
    dealProbabilityDefined:
      option.weight != null && Number.isFinite(option.weight),
    reach: null,
    reachDefined: false,
    zeroReach: false,
    available: false,
    reason,
    resolvedNodeId: null,
    actions: [],
    frequencies: [],
    player: null,
    ev: null,
    evDefined: false,
    equity: null,
    equityDefined: false,
  };
}

export function rowFromResolvedNode(
  option: ChanceCardOption,
  node: NodePayload,
  expectedActions: string[] | null,
): LineCardReportRow {
  const joint = readNodeJoint(node);
  const actions = node.actions ?? [];
  if (
    expectedActions &&
    expectedActions.length > 0 &&
    (actions.length !== expectedActions.length ||
      actions.some((label, index) => label !== expectedActions[index]))
  ) {
    return {
      ...unavailableRow(option, "Action set differs on this card"),
      resolvedNodeId: node.node_id,
      actions,
      frequencies: strategyFrequencies(node),
      ...joint,
    };
  }
  return {
    card: option.card,
    dealProbability: option.weight,
    dealProbabilityDefined:
      option.weight != null && Number.isFinite(option.weight),
    ...joint,
    available: true,
    reason: joint.zeroReach ? "Zero joint reach" : null,
    resolvedNodeId: node.node_id,
    actions,
    frequencies: strategyFrequencies(node),
    player: typeof node.player === "number" ? node.player : null,
    ev: null,
    evDefined: false,
    equity: null,
    equityDefined: false,
  };
}

/** Acting-player node EV from a `/values` payload, or null when undefined. */
export function lineCardEvFromValues(
  values: ActionValuesPayload | null | undefined,
  basis: EvDisplayBasis,
  actionLabels: string[],
): number | null {
  if (!values || values.pending) {
    return null;
  }
  const shown = withEvBasis(values, basis, actionLabels);
  if (!shown || shown.node_ev_defined === false) {
    return null;
  }
  const value = shown.node_ev;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Acting-player check-down equity, or null when the payload has no average. */
export function lineCardEquityFromPayload(
  payload: unknown,
  player: number | null | undefined,
): number | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const body = payload as {
    pending?: boolean;
    oop_equity?: number | null;
    ip_equity?: number | null;
  };
  if (body.pending) {
    return null;
  }
  const value = player === 1 ? body.ip_equity : body.oop_equity;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Target id for the report decision after picking a chance child. */
export function lineCardTargetId(
  reportNodeId: string,
  chanceNodeId: string,
  chanceChildNodeId: string,
): string {
  return linePreservingCardTargetId(
    reportNodeId,
    chanceNodeId,
    chanceChildNodeId,
  );
}

export function lineCardOptionsFromChance(
  chance: NodePayload | null | undefined,
): ChanceCardOption[] {
  return chanceCardOptions(chance).filter((option) => !option.blocked);
}

/**
 * Reach-weighted aggregate frequency for one action across available rows.
 * Empty reach is excluded (distinct from a legitimate 0% frequency).
 */
export function aggregateActionFrequency(
  rows: readonly LineCardReportRow[],
  actionIndex: number,
): number | null {
  let mass = 0;
  let total = 0;
  for (const row of rows) {
    if (!row.available || !row.reachDefined || row.zeroReach) {
      continue;
    }
    const freq = row.frequencies[actionIndex];
    if (freq == null || !Number.isFinite(freq) || row.reach == null) {
      continue;
    }
    mass += row.reach;
    total += row.reach * freq;
  }
  if (!(mass > 0)) {
    return null;
  }
  return total / mass;
}

export function isLineCardVaryStreet(
  street: DealStreet | null | undefined,
): street is LineCardVaryStreet {
  return street === "turn" || street === "river";
}
