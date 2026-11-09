/**
 * Same-line card comparison: one betting decision across turn/river cards.
 *
 * Line identity is the public betting index (compact `pN…` id) plus a card
 * street to vary. Deal probability and node reach stay separate quantities.
 */
import {
  chanceCardOptions,
  linePreservingCardTargetId,
  normalizeBoardCards,
  type ChanceCardOption,
  type DealStreet,
} from "./cards";
import { strategyFrequencies } from "./actionHistory";
import type { NodePayload } from "./types";

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
  };
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
