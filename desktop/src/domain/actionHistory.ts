import { groupHands } from "./browse";
import type { NodeActionChild, NodeCardChild, NodePayload } from "./types";

export interface LineCrumb {
  label: string;
  /** Present for Root (and any client-tracked stops). */
  nodeId?: string;
}

export interface NextActionChoice {
  key: string;
  label: string;
  nodeId: string | null;
  frequency: number | null;
  kind: "action" | "card";
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

export function lineCrumbs(
  line: string | null | undefined,
  rootNodeId: string | null | undefined,
): LineCrumb[] {
  const crumbs: LineCrumb[] = [
    { label: "Root", nodeId: rootNodeId || undefined },
  ];
  for (const label of splitActionLine(line)) {
    crumbs.push({ label });
  }
  return crumbs;
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
