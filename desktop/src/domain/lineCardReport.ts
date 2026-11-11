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
  parseCardCode,
  type CardRank,
  type CardSuit,
  type ChanceCardOption,
  type DealStreet,
} from "./cards";
import { strategyFrequencies } from "./actionHistory";
import { parseSizeToken } from "./betSizes";
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

/** Card predicate for Compare-runouts filtering (assistant / Study action). */
export interface LineCardCardPredicate {
  /** Keep only these suits (`h` hearts, …). Empty/omitted = any suit. */
  suits?: CardSuit[];
  /** Keep only these ranks. Empty/omitted = any rank. */
  ranks?: CardRank[];
  /** Drop cards whose rank pairs the fixed board (pre-vary street). */
  excludeBoardPair?: boolean;
}

/** Sort keys available without loading EV/equity (EV ranking is a follow-up). */
export type LineCardSortBy = "frequency" | "deal";

export type LineCardSortDirection = "asc" | "desc";

/** Active filter/sort applied to a loaded same-line report. */
export interface LineCardReportActiveFilter {
  predicate: LineCardCardPredicate;
  /** Board used for pair checks (source decision board). */
  board: string[];
  actionIndex: number | null;
  actionLabel: string | null;
  sortBy: LineCardSortBy;
  sortDirection: LineCardSortDirection;
  seat: "IP" | "OOP" | null;
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
  /** Optional assistant/Study filter; null/undefined = show all cards. */
  activeFilter?: LineCardReportActiveFilter | null;
  /** Cards matching `activeFilter`, in sort order. */
  matchedCards?: string[];
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

/** Board cards fixed while varying `street` (flop for turn; flop+turn for river). */
export function fixedBoardForLineCard(
  board: string[] | string | null | undefined,
  street: LineCardVaryStreet,
): string[] {
  const cards = normalizeBoardCards(board);
  if (street === "river") {
    return cards.slice(0, 4);
  }
  return cards.slice(0, 3);
}

function boardRanks(board: string[] | string | null | undefined): Set<string> {
  const ranks = new Set<string>();
  for (const card of normalizeBoardCards(board)) {
    const parsed = parseCardCode(card);
    if (parsed?.rank) {
      ranks.add(parsed.rank.toUpperCase());
    }
  }
  return ranks;
}

export function isCardSuit(value: string | null | undefined): value is CardSuit {
  return value === "s" || value === "h" || value === "d" || value === "c";
}

export function isCardRank(value: string | null | undefined): value is CardRank {
  return Boolean(value && (CARD_RANKS as readonly string[]).includes(value));
}

/** True when `card` satisfies the predicate against the fixed board for `street`. */
export function matchesLineCardPredicate(
  card: string,
  board: string[] | string | null | undefined,
  street: LineCardVaryStreet,
  predicate: LineCardCardPredicate | null | undefined,
): boolean {
  if (!predicate) {
    return true;
  }
  const parsed = parseCardCode(card);
  if (!parsed) {
    return false;
  }
  const rank = parsed.rank.toUpperCase() as CardRank;
  const suit = parsed.suit.toLowerCase() as CardSuit;
  if (predicate.suits?.length && !predicate.suits.includes(suit)) {
    return false;
  }
  if (predicate.ranks?.length && !predicate.ranks.includes(rank)) {
    return false;
  }
  if (predicate.excludeBoardPair) {
    const fixed = fixedBoardForLineCard(board, street);
    if (boardRanks(fixed).has(rank)) {
      return false;
    }
  }
  return true;
}

/** Pot-fraction encoded in a Study action label (`Bet 75`, `Bet 75% pot`, …). */
export function actionLabelPotFraction(label: string): number | null {
  const trimmed = label.trim();
  if (!trimmed) {
    return null;
  }
  if (/^(check|call|fold)\b/i.test(trimmed) || /^all[\s-]*in$/i.test(trimmed)) {
    return null;
  }
  const match = trimmed.match(/^(?:bet|raise)\s+(.+)$/i);
  if (!match?.[1]) {
    return null;
  }
  const rest = match[1].replace(/\bpot\b.*$/i, "").trim();
  const token = rest.split(/\s+/)[0] ?? "";
  return parseSizeToken(token);
}

function normalizeActionQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ");
}

/**
 * Resolve a size/label query against the source decision's action set.
 * Exact label wins; otherwise pot-fraction match (75% ↔ Bet 75).
 */
export function resolveLineCardAction(
  actionLabels: readonly string[],
  query: string | null | undefined,
):
  | { ok: true; index: number; label: string }
  | { ok: false; reason: string; supported: string[] } {
  const supported = [...actionLabels];
  if (!supported.length) {
    return {
      ok: false,
      reason: "This decision has no actions to rank by.",
      supported,
    };
  }
  if (query == null || !String(query).trim()) {
    return {
      ok: false,
      reason: `Pass an action to rank by (supported: ${supported.join(", ")}).`,
      supported,
    };
  }
  const normalized = normalizeActionQuery(String(query));
  const exact = supported.findIndex(
    (label) => label.trim().toLowerCase() === normalized.toLowerCase(),
  );
  if (exact >= 0) {
    return { ok: true, index: exact, label: supported[exact]! };
  }

  // Bare Check / Call / Fold / All-in when the query omits chips.
  const passive = normalized.toLowerCase();
  if (/^(check|call|fold|all[\s-]*in)$/i.test(passive)) {
    const index = supported.findIndex((label) => {
      const lower = label.trim().toLowerCase();
      if (passive.replace(/[\s-]+/g, "") === "allin") {
        return /^all[\s-]*in$/i.test(lower);
      }
      return lower === passive || lower.startsWith(`${passive} `);
    });
    if (index >= 0) {
      return { ok: true, index, label: supported[index]! };
    }
  }

  let queryFraction: number | null = null;
  const betish = normalized.match(/^(?:bet|raise)\s+(.+)$/i);
  if (betish?.[1]) {
    queryFraction = parseSizeToken(betish[1].replace(/\bpot\b.*$/i, "").trim().split(/\s+/)[0] ?? "");
  } else {
    queryFraction = parseSizeToken(normalized);
  }
  if (queryFraction != null && Number.isFinite(queryFraction)) {
    const matches: number[] = [];
    for (let index = 0; index < supported.length; index += 1) {
      const fraction = actionLabelPotFraction(supported[index]!);
      if (fraction != null && Math.abs(fraction - queryFraction) < 1e-6) {
        matches.push(index);
      }
    }
    if (matches.length === 1) {
      const index = matches[0]!;
      return { ok: true, index, label: supported[index]! };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        reason: `Action "${normalized}" matches multiple sizes (${matches
          .map((index) => supported[index])
          .join(", ")}). Use an exact label.`,
        supported,
      };
    }
  }

  return {
    ok: false,
    reason: `Action "${normalized}" is not available at this decision. Supported: ${supported.join(", ")}.`,
    supported,
  };
}

/**
 * Filter available rows by card predicate, then sort by action frequency or deal weight.
 * Unavailable / undefined sort keys sink to the end.
 */
export function filterAndSortLineCardRows(
  rows: readonly LineCardReportRow[],
  opts: {
    board: string[] | string | null | undefined;
    street: LineCardVaryStreet;
    predicate?: LineCardCardPredicate | null;
    actionIndex?: number | null;
    sortBy?: LineCardSortBy;
    sortDirection?: LineCardSortDirection;
  },
): LineCardReportRow[] {
  const sortBy = opts.sortBy ?? "frequency";
  const direction = opts.sortDirection ?? "desc";
  const sign = direction === "asc" ? 1 : -1;
  const actionIndex = opts.actionIndex ?? null;

  const matched = rows.filter((row) => {
    if (!row.available || !row.resolvedNodeId) {
      return false;
    }
    return matchesLineCardPredicate(
      row.card,
      opts.board,
      opts.street,
      opts.predicate,
    );
  });

  const sortKey = (row: LineCardReportRow): number | null => {
    if (sortBy === "deal") {
      return row.dealProbabilityDefined && row.dealProbability != null
        ? row.dealProbability
        : null;
    }
    if (actionIndex == null || actionIndex < 0) {
      return null;
    }
    const freq = row.frequencies[actionIndex];
    return freq != null && Number.isFinite(freq) ? freq : null;
  };

  return [...matched].sort((left, right) => {
    const leftKey = sortKey(left);
    const rightKey = sortKey(right);
    const leftOk = leftKey != null;
    const rightOk = rightKey != null;
    if (!leftOk && !rightOk) {
      return left.card.localeCompare(right.card);
    }
    if (!leftOk) {
      return 1;
    }
    if (!rightOk) {
      return -1;
    }
    const delta = (leftKey - rightKey) * sign;
    return delta !== 0 ? delta : left.card.localeCompare(right.card);
  });
}

/** Apply filter/sort onto a report model (pure; does not mutate). */
export function withLineCardReportFilter(
  report: LineCardReportModel,
  filter: LineCardReportActiveFilter | null | undefined,
): LineCardReportModel {
  if (!filter) {
    return {
      ...report,
      activeFilter: null,
      matchedCards: undefined,
    };
  }
  const matched = filterAndSortLineCardRows(report.rows, {
    board: filter.board,
    street: report.street,
    predicate: filter.predicate,
    actionIndex: filter.actionIndex,
    sortBy: filter.sortBy,
    sortDirection: filter.sortDirection,
  });
  return {
    ...report,
    activeFilter: filter,
    matchedCards: matched.map((row) => row.card),
  };
}
