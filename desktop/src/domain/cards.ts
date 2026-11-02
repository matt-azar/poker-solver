import type { NodePayload } from "./types";

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

export type CardRank = (typeof CARD_RANKS)[number];
export type CardSuit = (typeof CARD_SUITS)[number];
export type BoardStreet = "flop" | "turn" | "river";
/** Street whose next card is (or was) dealt at a chance node. */
export type DealStreet = "turn" | "river";

export const SUIT_SYMBOLS: Record<CardSuit, string> = {
  s: "♠",
  h: "♥",
  d: "♦",
  c: "♣",
};

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

export interface BoardGroups {
  flop: string[];
  turn: string | null;
  river: string | null;
}

export type BoardCardChangeResult =
  | { ok: true; street: DealStreet; chanceNodeId: string }
  | { ok: false; street: DealStreet; reason: string };

export function parseCardCode(card: string): { rank: string; suit: string } | null {
  const trimmed = card.trim();
  if (trimmed.length < 2) {
    return null;
  }
  return { rank: trimmed[0]!.toUpperCase(), suit: trimmed[1]!.toLowerCase() };
}

export function suitSymbol(suit: string | null | undefined): string {
  if (!suit) {
    return "";
  }
  const key = suit.toLowerCase() as CardSuit;
  return SUIT_SYMBOLS[key] ?? suit;
}

export function normalizeBoardCards(
  board: string[] | string | null | undefined,
): string[] {
  const list = Array.isArray(board)
    ? board
    : typeof board === "string"
      ? board.split(/\s+/).filter(Boolean)
      : [];
  const out: string[] = [];
  for (const card of list) {
    const parsed = parseCardCode(card);
    if (parsed) {
      out.push(`${parsed.rank}${parsed.suit}`);
    }
  }
  return out;
}

export function boardBlockers(board: string[] | string | null | undefined): Set<string> {
  return new Set(normalizeBoardCards(board));
}

/** Group board into flop (≤3) with optional turn/river for compact display. */
export function boardGroups(board: string[] | string | null | undefined): BoardGroups {
  const cards = normalizeBoardCards(board);
  return {
    flop: cards.slice(0, 3),
    turn: cards.length >= 4 ? cards[3]! : null,
    river: cards.length >= 5 ? cards[4]! : null,
  };
}

export function streetOfBoardIndex(index: number): BoardStreet | null {
  if (index >= 0 && index <= 2) {
    return "flop";
  }
  if (index === 3) {
    return "turn";
  }
  if (index === 4) {
    return "river";
  }
  return null;
}

/** Which street this chance node deals next, from current board length. */
export function dealStreetFromBoard(
  board: string[] | string | null | undefined,
): DealStreet | null {
  const len = normalizeBoardCards(board).length;
  if (len === 3) {
    return "turn";
  }
  if (len === 4) {
    return "river";
  }
  return null;
}

export function cycleRank(rank: string, delta: number): CardRank {
  const index = CARD_RANKS.indexOf(rank.toUpperCase() as CardRank);
  const base = index >= 0 ? index : 0;
  const len = CARD_RANKS.length;
  return CARD_RANKS[(base + delta % len + len) % len]!;
}

export function cycleSuit(suit: string, delta: number): CardSuit {
  const index = CARD_SUITS.indexOf(suit.toLowerCase() as CardSuit);
  const base = index >= 0 ? index : 0;
  const len = CARD_SUITS.length;
  return CARD_SUITS[(base + delta % len + len) % len]!;
}

/**
 * Flat index into a suits×ranks grid (4 rows × 13 cols).
 * Row = suit order in CARD_SUITS; column = rank order in CARD_RANKS.
 */
export function deckCellIndex(rank: string, suit: string): number {
  const row = CARD_SUITS.indexOf(suit.toLowerCase() as CardSuit);
  const col = CARD_RANKS.indexOf(rank.toUpperCase() as CardRank);
  if (row < 0 || col < 0) {
    return -1;
  }
  return row * CARD_RANKS.length + col;
}

export function deckCoords(index: number): { rank: CardRank; suit: CardSuit; row: number; col: number } {
  const cols = CARD_RANKS.length;
  const row = Math.floor(index / cols);
  const col = index % cols;
  return {
    row,
    col,
    suit: CARD_SUITS[row] ?? "s",
    rank: CARD_RANKS[col] ?? "A",
  };
}

/**
 * Raw chance-card row from explorer `json_inspection`.
 * Production engine uses `cards: [{ card, child_id, weight }]`.
 * Older UI fixtures used `children: [{ card, node_id, weight? }]`.
 */
export interface RawChanceCard {
  card?: string;
  child_id?: string;
  node_id?: string;
  weight?: number | null;
}

function isChanceCardEntry(value: unknown): value is RawChanceCard {
  return typeof value === "object" && value !== null && "card" in value;
}

/** Child public-node id: engine `child_id`, or legacy `node_id`. */
export function chanceCardChildId(entry: RawChanceCard): string | null {
  const id = entry.child_id ?? entry.node_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Prefer engine `cards[]`; fall back to object entries in `children`
 * (legacy / hand-built fixtures). Decision-node `children` are strings and
 * are ignored.
 */
export function chanceCardEntries(node: NodePayload): RawChanceCard[] {
  const fromCards = Array.isArray(node.cards)
    ? (node.cards as unknown[]).filter(isChanceCardEntry)
    : [];
  if (fromCards.length > 0) {
    return fromCards;
  }
  return (node.children ?? []).filter(isChanceCardEntry);
}

/** Legal next cards from a deal (next-card) node for the rank×suit picker. */
export function chanceCardOptions(node: NodePayload | null | undefined): ChanceCardOption[] {
  if (!node || node.kind !== "chance") {
    return [];
  }
  const blockers = boardBlockers(node.board);
  const byCard = new Map<string, ChanceCardOption>();
  for (const entry of chanceCardEntries(node)) {
    const nodeId = chanceCardChildId(entry);
    if (!entry.card || !nodeId) {
      continue;
    }
    const parsed = parseCardCode(entry.card);
    if (!parsed) {
      continue;
    }
    const code = `${parsed.rank}${parsed.suit}`;
    const weight =
      typeof entry.weight === "number" && Number.isFinite(entry.weight)
        ? entry.weight
        : null;
    byCard.set(code, {
      card: code,
      rank: parsed.rank,
      suit: parsed.suit,
      nodeId,
      weight,
      blocked: blockers.has(code),
    });
  }
  return Array.from(byCard.values());
}

/**
 * Full 52-cell deck in suits×ranks order (stable positions).
 * Unavailable / blocked cards stay in place as faded cells.
 */
export function fullDeckGrid(
  options: ChanceCardOption[],
  board: string[] | string | null | undefined,
): DeckCell[] {
  const byCard = new Map(options.map((option) => [option.card, option]));
  const blockers = boardBlockers(board);
  const cells: DeckCell[] = [];
  for (const suit of CARD_SUITS) {
    for (const rank of CARD_RANKS) {
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

export function isMissingDeckCell(
  cell: DeckCell,
): cell is Extract<DeckCell, { missing: true }> {
  return "missing" in cell && cell.missing;
}

export function isLegalDeckCell(cell: DeckCell): cell is ChanceCardOption {
  return !isMissingDeckCell(cell) && !cell.blocked;
}

/**
 * Decide whether the current node can open a next-card picker for `street`.
 *
 * Full line-preserving sibling-card swaps (jump back to an ancestor chance while
 * keeping the betting line) need parent/path APIs not exposed on main yet.
 * Until then, only the live deal node for that street is accepted.
 */
export function prepareBoardCardChange(
  node: NodePayload | null | undefined,
  street: DealStreet,
): BoardCardChangeResult {
  if (!node) {
    return {
      ok: false,
      street,
      reason: `No node loaded — solve a spot before changing the ${street}.`,
    };
  }
  if (node.kind !== "chance") {
    return {
      ok: false,
      street,
      reason:
        `Cannot change the ${street} from this decision without walking back to its deal node. ` +
        "Line-preserving sibling-card navigation is not wired yet — open the deal node first, " +
        "or use Action history / Navigator.",
    };
  }
  const dealing = dealStreetFromBoard(node.board);
  if (dealing == null) {
    return {
      ok: false,
      street,
      reason: "This chance node has no next-card deal for turn or river.",
    };
  }
  if (dealing !== street) {
    return {
      ok: false,
      street,
      reason: `This deal node is for the ${dealing}, not the ${street}. Navigate to the ${street} deal to change it.`,
    };
  }
  if (chanceCardOptions(node).length === 0) {
    return {
      ok: false,
      street,
      reason: "No legal next cards at this deal node.",
    };
  }
  return { ok: true, street, chanceNodeId: node.node_id };
}
