import { formatActionDisplay } from "./betSizes";
import { groupHands } from "./browse";
import type { NodeActionChild, NodeCardChild, NodePayload } from "./types";

/**
 * Betting-path navigation helpers.
 *
 * `parent_id` is now exposed on inspection, but street-grouped ownership and
 * prior-action alternatives still rely on a validated client `pathTrail`
 * recorded while navigating (siblings + actor at each step). Without a trail,
 * line crumbs remain labels-only (Root / parent_id jumps still work).
 */

export type PathStreet = "flop" | "turn" | "river";

export interface LineCrumb {
  label: string;
  /** Present for Root (and any client-tracked stops). */
  nodeId?: string;
  street?: PathStreet;
  actor?: string | null;
  kind?: "root" | "action" | "card" | "terminal";
  rawLabel?: string;
  alternatives?: PathAlternative[];
}

export interface PathAlternative {
  label: string;
  nodeId: string | null;
  kind: "action" | "card";
}

export interface PathStep {
  /** Node reached by this step. */
  nodeId: string;
  /** Compact display label (e.g. `b50`, `As`). */
  label: string;
  /** Engine / raw label for tooltips. */
  rawLabel: string;
  kind: "root" | "action" | "card" | "terminal";
  street: PathStreet;
  /** Seat that chose this action at the parent; null for root / deals. */
  actor: string | null;
  /** Dealt board card when kind === "card". */
  card?: string;
  /** Sibling choices available at the parent when this step was taken. */
  alternatives?: PathAlternative[];
  /** Parent public-node id when known from trail or `parent_id`. */
  parentId?: string | null;
}

export interface PathStreetGroup {
  street: PathStreet;
  /** Board cards belonging to this street from the current board. */
  boardCards: string[];
  steps: PathStep[];
}

export interface NextActionChoice {
  key: string;
  label: string;
  nodeId: string | null;
  frequency: number | null;
  kind: "action" | "card";
}

export interface NavHistoryEntry {
  nodeId: string;
  trail: PathStep[];
}

/** Split an engine `line` path (`Check/Bet 50/Call`) into readable crumbs. */
export function splitActionLine(line: string | null | undefined): string[] {
  if (!line) {
    return [];
  }
  const trimmed = line.trim();
  if (!trimmed || trimmed === "open" || trimmed === "root") {
    return [];
  }
  return trimmed
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function boardCardList(
  board: string[] | string | null | undefined,
): string[] {
  if (Array.isArray(board)) {
    return board.map(String).filter(Boolean);
  }
  if (typeof board === "string" && board.trim()) {
    return board.trim().split(/\s+/).filter(Boolean);
  }
  return [];
}

/**
 * Map engine `place` (+ board length fallback) to a street bucket.
 * Places like `turn Ah river Kd` count as river.
 */
export function streetFromPlace(
  place: string | null | undefined,
  boardLen = 0,
): PathStreet {
  const p = (place || "").trim().toLowerCase();
  if (p.includes("deal river") || /\briver\b/.test(p)) {
    return "river";
  }
  if (p.includes("deal turn") || /\bturn\b/.test(p)) {
    return "turn";
  }
  if (p.startsWith("flop")) {
    return "flop";
  }
  if (boardLen >= 5) {
    return "river";
  }
  if (boardLen === 4) {
    return "turn";
  }
  return "flop";
}

export function streetLabel(street: PathStreet): string {
  if (street === "flop") {
    return "Flop";
  }
  if (street === "turn") {
    return "Turn";
  }
  return "River";
}

/** Board cards that belong visually with a street group. */
export function boardCardsForStreet(
  street: PathStreet,
  board: string[] | string | null | undefined,
): string[] {
  const cards = boardCardList(board);
  if (street === "flop") {
    return cards.slice(0, 3);
  }
  if (street === "turn") {
    return cards.length >= 4 ? [cards[3]!] : [];
  }
  return cards.length >= 5 ? [cards[4]!] : [];
}

/** Compact primary action label for path chrome (`b50`, not `Bet 50%`). */
export function compactActionLabel(label: string, pot: number): string {
  const trimmed = label.trim();
  if (!trimmed) {
    return trimmed;
  }
  // Card codes stay as-is.
  if (/^[2-9TJQKA][cdhs]$/i.test(trimmed)) {
    return trimmed.length === 2
      ? trimmed[0]!.toUpperCase() + trimmed[1]!.toLowerCase()
      : trimmed;
  }
  return formatActionDisplay(trimmed, pot, "pot").primary;
}

export function lineCrumbs(
  line: string | null | undefined,
  rootNodeId: string | null | undefined,
  pot = 0,
): LineCrumb[] {
  const crumbs: LineCrumb[] = [
    { label: "Root", nodeId: rootNodeId || undefined, kind: "root" },
  ];
  for (const label of splitActionLine(line)) {
    crumbs.push({
      label: compactActionLabel(label, pot),
      rawLabel: label,
      kind: "action",
    });
  }
  return crumbs;
}

/**
 * Prefer the client trail (with node ids + ownership). Fall back to line
 * crumbs when the trail is empty or does not end at the current node.
 */
export function pathCrumbsFromTrail(
  trail: PathStep[] | null | undefined,
  line: string | null | undefined,
  rootNodeId: string | null | undefined,
  currentNodeId: string | null | undefined,
  pot = 0,
): LineCrumb[] {
  if (
    trail &&
    trail.length > 0 &&
    (!currentNodeId || trail[trail.length - 1]?.nodeId === currentNodeId)
  ) {
    return trail.map((step) => ({
      label: step.label,
      nodeId: step.nodeId,
      street: step.street,
      actor: step.actor,
      kind: step.kind,
      rawLabel: step.rawLabel,
      alternatives: step.alternatives,
    }));
  }
  return lineCrumbs(line, rootNodeId, pot);
}

export function groupPathByStreet(
  steps: PathStep[],
  board?: string[] | string | null,
): PathStreetGroup[] {
  const groups: PathStreetGroup[] = [];
  for (const step of steps) {
    const last = groups[groups.length - 1];
    if (last && last.street === step.street) {
      last.steps.push(step);
      continue;
    }
    groups.push({
      street: step.street,
      boardCards: boardCardsForStreet(step.street, board),
      steps: [step],
    });
  }
  // Ensure board cards are filled even when a street has only Root later upgraded.
  for (const group of groups) {
    if (!group.boardCards.length) {
      group.boardCards = boardCardsForStreet(group.street, board);
    }
  }
  return groups;
}

/** Group line crumbs (possibly without node ids) by street when trail missing. */
export function groupCrumbsByStreet(
  crumbs: LineCrumb[],
  board?: string[] | string | null,
  place?: string | null,
): PathStreetGroup[] {
  const boardLen = boardCardList(board).length;
  const currentStreet = streetFromPlace(place, boardLen);
  // Without a trail we cannot split actions across streets; put Root alone on
  // flop (or earliest board street) and remaining labels on the current street.
  if (!crumbs.length) {
    return [];
  }
  const root = crumbs[0]!;
  const rest = crumbs.slice(1);
  const rootStreet: PathStreet =
    boardLen >= 5 ? "flop" : boardLen === 4 ? "flop" : "flop";
  const steps: PathStep[] = [
    {
      nodeId: root.nodeId || "",
      label: root.label,
      rawLabel: root.rawLabel || root.label,
      kind: root.kind || "root",
      street: rootStreet,
      actor: null,
      alternatives: root.alternatives,
    },
  ];
  for (const crumb of rest) {
    steps.push({
      nodeId: crumb.nodeId || "",
      label: crumb.label,
      rawLabel: crumb.rawLabel || crumb.label,
      kind: crumb.kind || "action",
      street: crumb.street || currentStreet,
      actor: crumb.actor ?? null,
      alternatives: crumb.alternatives,
    });
  }
  return groupPathByStreet(steps, board);
}

function childNodeId(
  child: NodeActionChild | NodeCardChild | string | undefined,
): string | null {
  if (child == null) {
    return null;
  }
  if (typeof child === "string") {
    return child;
  }
  return child.node_id ?? null;
}

function strategyFrequencies(node: NodePayload): number[] {
  const labels = node.actions ?? [];
  if (!labels.length) {
    return [];
  }
  const cells = groupHands(node);
  const totals = labels.map(() => 0);
  let mass = 0;
  for (const cell of cells) {
    if (!cell.defined || cell.marginalSum <= 0) {
      continue;
    }
    mass += cell.marginalSum;
    cell.actionMass.forEach((value, index) => {
      totals[index] += value;
    });
  }
  if (!(mass > 0)) {
    return labels.map(() => 0);
  }
  return totals.map((total) => total / mass);
}

type NodeCardsField = {
  card?: string;
  child_id?: string;
  node_id?: string;
  weight?: number | null;
};

/** Next legal moves from the current node (actions or chance cards). */
export function nextChoicesFromNode(node: NodePayload | null | undefined): NextActionChoice[] {
  if (!node) {
    return [];
  }

  if (node.kind === "chance") {
    const fromChildren: NextActionChoice[] = [];
    (node.children ?? []).forEach((child, index) => {
      if (typeof child !== "object" || child === null || !("card" in child)) {
        return;
      }
      const card = child.card || "?";
      fromChildren.push({
        key: `card-${card}-${index}`,
        label: card,
        nodeId: child.node_id ?? null,
        frequency: null,
        kind: "card",
      });
    });
    if (fromChildren.length) {
      return fromChildren;
    }
    const cards = Array.isArray(node.cards) ? (node.cards as NodeCardsField[]) : [];
    return cards.map((card, index) => ({
      key: `card-${card.card ?? index}-${index}`,
      label: card.card || "?",
      nodeId: card.child_id ?? card.node_id ?? null,
      frequency: null,
      kind: "card" as const,
    }));
  }

  const labels = node.actions ?? [];
  if (!labels.length) {
    return [];
  }
  const freqs = strategyFrequencies(node);
  const children = node.children ?? [];
  return labels.map((label, index) => ({
    key: `action-${label}-${index}`,
    label,
    nodeId: childNodeId(children[index]),
    frequency: freqs[index] ?? null,
    kind: "action" as const,
  }));
}

export function formatChoiceFrequency(frequency: number | null | undefined): string | null {
  if (frequency == null || !Number.isFinite(frequency)) {
    return null;
  }
  return `${Math.round(frequency * 100)}%`;
}

export function actorLabel(
  toAct: string | null | undefined,
  player: number | null | undefined,
): string {
  if (toAct) {
    return toAct;
  }
  if (player === 0) {
    return "OOP";
  }
  if (player === 1) {
    return "IP";
  }
  return "—";
}

/** Current node pot, falling back to root/job/draft values. */
export function nodePot(
  node: NodePayload | null | undefined,
  fallback = 0,
): number {
  const pot = Number(node?.pot ?? fallback);
  return Number.isFinite(pot) ? pot : fallback;
}

/**
 * Pot basis for bet/raise % tags: current pot, plus to_call when facing a bet
 * (engine sizes raises against pot + call).
 */
export function actionSizePotBasis(
  node: NodePayload | null | undefined,
  fallback = 0,
): number {
  const pot = nodePot(node, fallback);
  if (!(pot > 0)) {
    return fallback;
  }
  const toCall = Number(node?.to_call ?? 0);
  return toCall > 0 ? pot + toCall : pot;
}

/** Remaining effective stack at the node (min of seats). */
export function nodeEffectiveStack(
  node: NodePayload | null | undefined,
  fallback = 0,
): number {
  const stacks = node?.stacks;
  if (Array.isArray(stacks) && stacks.length >= 2) {
    const left = Number(stacks[0]);
    const right = Number(stacks[1]);
    if (Number.isFinite(left) && Number.isFinite(right)) {
      return Math.min(left, right);
    }
  }
  const single = Number(node?.stack ?? fallback);
  return Number.isFinite(single) ? single : fallback;
}

function foldedSeatLabel(folded: unknown): string | null {
  if (folded === 0 || folded === "0") {
    return "OOP folded";
  }
  if (folded === 1 || folded === "1") {
    return "IP folded";
  }
  return null;
}

/**
 * Status chip for the path chrome: Deal / Fold / Showdown / `{actor} to act`.
 * Distinguishes fold terminals from showdown (engine `folded` or line heuristic).
 */
export function nodeStatusLabel(node: NodePayload | null | undefined): string {
  if (!node) {
    return "—";
  }
  if (node.kind === "chance") {
    return "Deal";
  }
  if (node.kind === "terminal") {
    const fromField = foldedSeatLabel(node.folded);
    if (fromField) {
      return fromField;
    }
    const parts = splitActionLine(node.line);
    const last = (parts[parts.length - 1] || "").toLowerCase();
    if (last.startsWith("fold")) {
      return "Fold";
    }
    return "Showdown";
  }
  return `${actorLabel(node.to_act, node.player ?? null)} to act`;
}

export function isTerminalFold(node: NodePayload | null | undefined): boolean {
  if (!node || node.kind !== "terminal") {
    return false;
  }
  const label = nodeStatusLabel(node);
  return label === "Fold" || label.endsWith("folded");
}

export function rootPathStep(
  rootNodeId: string,
  board?: string[] | string | null,
  place?: string | null,
): PathStep {
  const street = streetFromPlace(place, boardCardList(board).length);
  return {
    nodeId: rootNodeId,
    label: "Root",
    rawLabel: "Root",
    kind: "root",
    street: street === "river" || street === "turn" ? "flop" : street,
    actor: null,
    parentId: null,
  };
}

/** Build the path step taken when leaving `from` toward `toNodeId`. */
export function edgeStepFromNode(
  from: NodePayload,
  toNodeId: string,
  pot: number,
): PathStep | null {
  const choices = nextChoicesFromNode(from);
  const choice = choices.find((item) => item.nodeId === toNodeId);
  if (!choice) {
    return null;
  }
  const board = boardCardList(from.board);
  const place =
    typeof from.place === "string" ? from.place : null;
  let street = streetFromPlace(place, board.length);
  if (from.kind === "chance") {
    street = streetFromPlace(place, board.length) === "flop" ? "turn" : street;
    if ((place || "").toLowerCase().includes("deal turn")) {
      street = "turn";
    } else if ((place || "").toLowerCase().includes("deal river")) {
      street = "river";
    } else if (board.length <= 3) {
      street = "turn";
    } else {
      street = "river";
    }
  }
  const alternatives: PathAlternative[] = choices
    .filter((item) => item.nodeId && item.nodeId !== toNodeId)
    .map((item) => ({
      label: compactActionLabel(item.label, pot),
      nodeId: item.nodeId,
      kind: item.kind,
    }));
  const actor =
    from.kind === "decision"
      ? actorLabel(from.to_act, from.player ?? null)
      : null;
  const parentId =
    typeof from.parent_id === "string" ? from.parent_id : from.node_id;
  return {
    nodeId: toNodeId,
    label: compactActionLabel(choice.label, pot),
    rawLabel: choice.label,
    kind: choice.kind === "card" ? "card" : "action",
    street,
    actor,
    card: choice.kind === "card" ? choice.label : undefined,
    alternatives: alternatives.length ? alternatives : undefined,
    parentId,
  };
}

/**
 * Extend or repair the client trail after arriving at `arrived`.
 * If `from` is the trail tip, append `edge`; if jumping to an ancestor,
 * truncate; otherwise reset to root + synthetic edge when possible.
 */
export function advancePathTrail(
  trail: PathStep[],
  from: NodePayload | null | undefined,
  arrived: NodePayload,
  pot: number,
  rootNodeId: string,
): PathStep[] {
  const arrivedStepKind: PathStep["kind"] =
    arrived.kind === "terminal"
      ? "terminal"
      : arrived.kind === "chance"
        ? "card"
        : "action";

  if (!from) {
    return [rootPathStep(rootNodeId, arrived.board, String(arrived.place ?? ""))];
  }

  // Clicked an ancestor already on the trail.
  const ancestorIdx = trail.findIndex((step) => step.nodeId === arrived.node_id);
  if (ancestorIdx >= 0) {
    return trail.slice(0, ancestorIdx + 1);
  }

  const tip = trail[trail.length - 1];
  if (tip && tip.nodeId === from.node_id) {
    const edge = edgeStepFromNode(from, arrived.node_id, pot);
    if (edge) {
      // Refine kind once we know the destination.
      if (arrived.kind === "terminal") {
        edge.kind = "terminal";
      }
      return [...trail, edge];
    }
  }

  // Trail out of sync — rebuild from root using line labels (no mid node ids).
  const base = [rootPathStep(rootNodeId, arrived.board, String(arrived.place ?? ""))];
  const edge = from ? edgeStepFromNode(from, arrived.node_id, pot) : null;
  if (edge) {
    if (arrived.kind === "terminal") {
      edge.kind = arrivedStepKind;
    }
    // Keep prior trail prefix that still matches `from`.
    const fromIdx = trail.findIndex((step) => step.nodeId === from.node_id);
    if (fromIdx >= 0) {
      return [...trail.slice(0, fromIdx + 1), edge];
    }
    return [...base, edge];
  }
  return base;
}

/** Replace the action at `stepIndex` with an alternative child id. */
export function replaceTrailAlternative(
  trail: PathStep[],
  stepIndex: number,
  alternative: PathAlternative,
  pot: number,
): PathStep[] | null {
  if (stepIndex <= 0 || stepIndex >= trail.length || !alternative.nodeId) {
    return null;
  }
  const prior = trail[stepIndex]!;
  const next: PathStep = {
    ...prior,
    nodeId: alternative.nodeId,
    label: alternative.label,
    rawLabel: alternative.label,
    kind: alternative.kind === "card" ? "card" : "action",
    card: alternative.kind === "card" ? alternative.label : undefined,
    alternatives: prior.alternatives
      ? [
          ...prior.alternatives.filter((alt) => alt.nodeId !== alternative.nodeId),
          {
            label: prior.label,
            nodeId: prior.nodeId,
            kind: prior.kind === "card" ? "card" : "action",
          },
        ]
      : undefined,
  };
  // Drop descendants — they belong to the old branch.
  void pot;
  return [...trail.slice(0, stepIndex), next];
}

export function pushNavHistory(
  entries: NavHistoryEntry[],
  index: number,
  entry: NavHistoryEntry,
): { entries: NavHistoryEntry[]; index: number } {
  const trimmed = entries.slice(0, Math.max(0, index + 1));
  const last = trimmed[trimmed.length - 1];
  if (last && last.nodeId === entry.nodeId) {
    // Replace trail snapshot for the same node.
    const copy = trimmed.slice();
    copy[copy.length - 1] = entry;
    return { entries: copy, index: copy.length - 1 };
  }
  trimmed.push(entry);
  // Cap history length.
  const capped =
    trimmed.length > 100 ? trimmed.slice(trimmed.length - 100) : trimmed;
  return { entries: capped, index: capped.length - 1 };
}

export function canNavBack(index: number): boolean {
  return index > 0;
}

export function canNavForward(entries: NavHistoryEntry[], index: number): boolean {
  return index >= 0 && index < entries.length - 1;
}
