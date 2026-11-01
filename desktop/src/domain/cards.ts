import type { NodeCardChild, NodePayload } from "./types";

export const CARD_RANKS = [
  "A",
  "K",
  "Q",
  "J",
  "T",
  "9",
  "8",
  "7",
  "6",
  "5",
  "4",
  "3",
  "2",
] as const;
export const CARD_SUITS = ["s", "h", "d", "c"] as const;

export interface ChanceCardOption {
  card: string;
  rank: string;
  suit: string;
  nodeId: string;
  weight: number | null;
  blocked: boolean;
}

export type DeckCell =
  | ChanceCardOption
  | { card: string; rank: string; suit: string; missing: true; blocked: boolean };

export function parseCardCode(card: string): { rank: string; suit: string } | null {
  const trimmed = card.trim();
  if (trimmed.length < 2) {
    return null;
  }
  return { rank: trimmed[0]!.toUpperCase(), suit: trimmed[1]!.toLowerCase() };
}

export function boardBlockers(board: string[] | string | null | undefined): Set<string> {
  const out = new Set<string>();
  const list = Array.isArray(board)
    ? board
    : typeof board === "string"
      ? board.split(/\s+/).filter(Boolean)
      : [];
  for (const card of list) {
    const parsed = parseCardCode(card);
    if (parsed) {
      out.add(`${parsed.rank}${parsed.suit}`);
    }
  }
  return out;
}

function isCardChild(child: unknown): child is NodeCardChild {
  return typeof child === "object" && child !== null && "card" in child;
}

/** Legal next cards from a deal (next-card) node for the rank×suit picker. */
export function chanceCardOptions(node: NodePayload | null | undefined): ChanceCardOption[] {
  if (!node || node.kind !== "chance") {
    return [];
  }
  const blockers = boardBlockers(node.board);
  const byCard = new Map<string, ChanceCardOption>();
  for (const child of node.children ?? []) {
    if (!isCardChild(child) || !child.card || !child.node_id) {
      continue;
    }
    const parsed = parseCardCode(child.card);
    if (!parsed) {
      continue;
    }
    const code = `${parsed.rank}${parsed.suit}`;
    byCard.set(code, {
      card: code,
      rank: parsed.rank,
      suit: parsed.suit,
      nodeId: child.node_id,
      weight: child.weight ?? null,
      blocked: blockers.has(code),
    });
  }
  return Array.from(byCard.values());
}

export function fullDeckGrid(
  options: ChanceCardOption[],
  board: string[] | string | null | undefined,
): DeckCell[] {
  const byCard = new Map(options.map((option) => [option.card, option]));
  const blockers = boardBlockers(board);
  const cells: DeckCell[] = [];
  for (const rank of CARD_RANKS) {
    for (const suit of CARD_SUITS) {
      const code = `${rank}${suit}`;
      const existing = byCard.get(code);
      if (existing) {
        cells.push(existing);
      } else {
        cells.push({
          card: code,
          rank,
          suit,
          missing: true,
          blocked: blockers.has(code),
        });
      }
    }
  }
  return cells;
}
