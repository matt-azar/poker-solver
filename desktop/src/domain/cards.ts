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

/** Minimal trail step shape for resolving a deal-chance ancestor. */
export interface DealPathStepRef {
  nodeId: string;
  kind: string;
  street: string;
  parentId?: string | null;
}

/** Parsed `pN.tT.rR` public-node id (engine StreetBatch / explorer form). */
export interface PublicNodeIdParts {
  /** Public betting index N. */
  index: number;
  /** Encoded turn card (or -1). */
  turn: number;
  /** Encoded river card (or -1). */
  river: number;
}

const PUBLIC_NODE_ID_RE = /^p(-?\d+)\.t(-?\d+)\.r(-?\d+)$/;

/** Parse explorer public ids like `p12.t40.r7`. Non-matching ids return null. */
export function parsePublicNodeId(nodeId: string): PublicNodeIdParts | null {
  const match = PUBLIC_NODE_ID_RE.exec(nodeId.trim());
  if (!match) {
    return null;
  }
  return {
    index: Number(match[1]),
    turn: Number(match[2]),
    river: Number(match[3]),
  };
}

export function formatPublicNodeId(parts: PublicNodeIdParts): string {
  return `p${parts.index}.t${parts.turn}.r${parts.river}`;
}

/**
 * Keep the current node's public betting index N; take `.t`/`.r` from the
 * selected chance child's runout. Returns null when either id is not `pN.tT.rR`.
 */
export function rewriteNodeIdRunout(
  currentNodeId: string,
  chanceChildNodeId: string,
): string | null {
  const current = parsePublicNodeId(currentNodeId);
  const child = parsePublicNodeId(chanceChildNodeId);
  if (!current || !child) {
    return null;
  }
  return formatPublicNodeId({
    index: current.index,
    turn: child.turn,
    river: child.river,
  });
}

/**
 * Target id after picking a chance card while staying on the betting line.
 * At the deal node itself, the chance child id is already correct.
 */
export function linePreservingCardTargetId(
  currentNodeId: string,
  chanceNodeId: string,
  chanceChildNodeId: string,
): string {
  if (currentNodeId === chanceNodeId) {
    return chanceChildNodeId;
  }
  return rewriteNodeIdRunout(currentNodeId, chanceChildNodeId) ?? chanceChildNodeId;
}

/** True when `node` is the live chance deal for `street`. */
export function isDealChanceForStreet(
  node: NodePayload | null | undefined,
  street: DealStreet,
): boolean {
  if (!node || node.kind !== "chance") {
    return false;
  }
  return dealStreetFromBoard(node.board) === street;
}

/**
 * Changing an earlier street once a later card is dealt is out of scope
 * (e.g. turn swap after the river is already on the board).
 */
export function boardCardChangeBlockedByLaterStreet(
  node: NodePayload | null | undefined,
  street: DealStreet,
): string | null {
  if (!node) {
    return null;
  }
  const len = normalizeBoardCards(node.board).length;
  if (street === "turn" && len >= 5) {
    return "Cannot change the turn after the river is dealt.";
  }
  return null;
}

/**
 * Prefer the trail: the step before the first card deal for `street` is the
 * chance node we navigated through. Falls back to the card step's parentId when
 * the prior tip was not recorded.
 */
export function resolveDealChanceIdFromTrail(
  trail: readonly DealPathStepRef[] | null | undefined,
  street: DealStreet,
): string | null {
  if (!trail || trail.length === 0) {
    return null;
  }
  const cardIdx = trail.findIndex(
    (step) => step.kind === "card" && step.street === street,
  );
  if (cardIdx > 0) {
    const prior = trail[cardIdx - 1];
    if (prior?.nodeId) {
      return prior.nodeId;
    }
  }
  if (cardIdx >= 0) {
    const parentId = trail[cardIdx]?.parentId;
    if (typeof parentId === "string" && parentId.length > 0) {
      return parentId;
    }
  }
  // Still sitting on the deal node (trail tip) before a card is chosen.
  const tip = trail[trail.length - 1];
  if (tip && tip.street === street && tip.kind !== "card" && tip.kind !== "terminal") {
    // Ambiguous without a payload — callers still verify via isDealChanceForStreet.
    return tip.nodeId;
  }
  return null;
}

/**
 * Decide whether a next-card picker can open for `street`.
 *
 * Accepts the live matching deal node, or a resolved deal-chance ancestor
 * (from `pathTrail` / `parent_id` walk) while the user stays on a deeper line.
 */
export function prepareBoardCardChange(
  node: NodePayload | null | undefined,
  street: DealStreet,
  chanceAncestor?: NodePayload | null,
): BoardCardChangeResult {
  if (!node) {
    return {
      ok: false,
      street,
      reason: `No node loaded — solve a spot before changing the ${street}.`,
    };
  }
  const later = boardCardChangeBlockedByLaterStreet(node, street);
  if (later) {
    return { ok: false, street, reason: later };
  }

  let deal: NodePayload | null = null;
  if (isDealChanceForStreet(node, street)) {
    deal = node;
  } else if (chanceAncestor && isDealChanceForStreet(chanceAncestor, street)) {
    deal = chanceAncestor;
  }

  if (!deal) {
    if (chanceAncestor && chanceAncestor.kind === "chance") {
      const dealing = dealStreetFromBoard(chanceAncestor.board);
      if (dealing != null && dealing !== street) {
        return {
          ok: false,
          street,
          reason: `Resolved deal node is for the ${dealing}, not the ${street}.`,
        };
      }
    }
    return {
      ok: false,
      street,
      reason:
        `Cannot resolve the ${street} deal-chance ancestor from this node. ` +
        "Navigate through the deal once (so path history records it) or open the deal node.",
    };
  }

  if (chanceCardOptions(deal).length === 0) {
    return {
      ok: false,
      street,
      reason: "No legal next cards at this deal node.",
    };
  }
  return { ok: true, street, chanceNodeId: deal.node_id };
}
