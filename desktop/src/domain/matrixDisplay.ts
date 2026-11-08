/**
 * Study matrix display prefs + pure aggregation helpers.
 * Persisted separately from settingsStore so Study UI can ship before parent wires SettingsDialog.
 */
import { create } from "zustand";
import { withEvBasis } from "./browse";
import type { AggregatedHandCell } from "./browse";
import { SUIT_SYMBOLS, type CardSuit } from "./cards";
import { canonicalizeCombo } from "./range";
import type {
  ActionValuesPayload,
  EvDisplayBasis,
  NodePayload,
} from "./types";

/** Normalize a 4-char combo to engine order so slot lookups match fixture/node variants. */
export function comboKey(combo: string): string {
  if (combo.length < 4) {
    return combo;
  }
  try {
    return canonicalizeCombo(combo.slice(0, 2), combo.slice(2, 4));
  } catch {
    return combo;
  }
}

const MATRIX_DISPLAY_KEY = "study-matrix-display-v1";

export type MatrixCellOverlay = "none" | "ev" | "equity" | "both";

export interface MatrixDisplayPrefs {
  /** Pio-style: colored bar grows from the bottom by range inclusion weight. */
  rangeWeightHeightFill: boolean;
  /** Secondary label (and optional tint) — independent of Strategy/Range/EV mode. */
  cellOverlay: MatrixCellOverlay;
  /** When true and overlay includes EV/equity, tint the empty fill / solid background. */
  colorByOverlay: boolean;
}

export const DEFAULT_MATRIX_DISPLAY_PREFS: MatrixDisplayPrefs = {
  rangeWeightHeightFill: false,
  cellOverlay: "none",
  colorByOverlay: false,
};

export interface EquityHandLike {
  combo: string;
  equity: number;
  weight?: number;
}

export interface EquityPayloadLike {
  pending?: boolean;
  oop_hands?: EquityHandLike[];
  ip_hands?: EquityHandLike[];
  oop_equity?: number | null;
  ip_equity?: number | null;
}

export type ComboShape = "pair" | "suited" | "offsuit";

export interface ComboBreakdownSquare {
  /** Engine combo key (e.g. AhKd) when present in the node; otherwise expected slot key. */
  combo: string;
  /** Short suit-pair label (e.g. ♠♥, hh, hd). */
  label: string;
  /** Engine reach for this combo (0–1); null when undefined. */
  reach: number | null;
  /** Posterior marginal mass; null when undefined. */
  marginal: number | null;
  /** Per-action strategy mix for this combo (same order as node.actions). */
  strategy: number[] | null;
  /** Mixed strategy EV for this combo under the display basis. */
  ev: number | null;
  /** Check-down equity for this combo when loaded. */
  equity: number | null;
  /** True when the combo is listed on the current node. */
  present: boolean;
}

function clampOverlay(value: unknown): MatrixCellOverlay {
  if (value === "ev" || value === "equity" || value === "both" || value === "none") {
    return value;
  }
  return DEFAULT_MATRIX_DISPLAY_PREFS.cellOverlay;
}

export function normalizeMatrixDisplayPrefs(
  partial: Partial<MatrixDisplayPrefs> | null | undefined,
): MatrixDisplayPrefs {
  return {
    rangeWeightHeightFill: Boolean(
      partial?.rangeWeightHeightFill ?? DEFAULT_MATRIX_DISPLAY_PREFS.rangeWeightHeightFill,
    ),
    cellOverlay: clampOverlay(partial?.cellOverlay),
    colorByOverlay: Boolean(
      partial?.colorByOverlay ?? DEFAULT_MATRIX_DISPLAY_PREFS.colorByOverlay,
    ),
  };
}

function loadPrefs(): MatrixDisplayPrefs {
  try {
    if (typeof localStorage === "undefined") {
      return { ...DEFAULT_MATRIX_DISPLAY_PREFS };
    }
    const raw = localStorage.getItem(MATRIX_DISPLAY_KEY);
    if (!raw) {
      return { ...DEFAULT_MATRIX_DISPLAY_PREFS };
    }
    return normalizeMatrixDisplayPrefs(JSON.parse(raw) as Partial<MatrixDisplayPrefs>);
  } catch {
    return { ...DEFAULT_MATRIX_DISPLAY_PREFS };
  }
}

function savePrefs(prefs: MatrixDisplayPrefs) {
  try {
    if (typeof localStorage === "undefined") {
      return;
    }
    localStorage.setItem(MATRIX_DISPLAY_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

interface MatrixDisplayState {
  prefs: MatrixDisplayPrefs;
  setPrefs: (partial: Partial<MatrixDisplayPrefs>) => void;
  setRangeWeightHeightFill: (on: boolean) => void;
  setCellOverlay: (overlay: MatrixCellOverlay) => void;
  setColorByOverlay: (on: boolean) => void;
  resetPrefs: () => void;
}

export const useMatrixDisplayStore = create<MatrixDisplayState>((set, get) => ({
  prefs:
    typeof localStorage === "undefined"
      ? { ...DEFAULT_MATRIX_DISPLAY_PREFS }
      : loadPrefs(),
  setPrefs(partial) {
    const prefs = normalizeMatrixDisplayPrefs({ ...get().prefs, ...partial });
    savePrefs(prefs);
    set({ prefs });
  },
  setRangeWeightHeightFill(on) {
    get().setPrefs({ rangeWeightHeightFill: on });
  },
  setCellOverlay(overlay) {
    get().setPrefs({ cellOverlay: overlay });
  },
  setColorByOverlay(on) {
    get().setPrefs({ colorByOverlay: on });
  },
  resetPrefs() {
    const prefs = { ...DEFAULT_MATRIX_DISPLAY_PREFS };
    savePrefs(prefs);
    set({ prefs });
  },
}));

/** Map acting-seat player index to equity seat key. */
export function equitySeatForPlayer(
  player: number | null | undefined,
): "oop" | "ip" | null {
  if (player === 0) {
    return "oop";
  }
  if (player === 1) {
    return "ip";
  }
  return null;
}

/** Hands for the acting seat from an equity payload; null when pending/missing. */
export function equityHandsForNode(
  equity: EquityPayloadLike | null | undefined,
  player: number | null | undefined,
): EquityHandLike[] | null {
  if (!equity || equity.pending) {
    return null;
  }
  const seat = equitySeatForPlayer(player);
  if (!seat) {
    return null;
  }
  const hands = seat === "oop" ? equity.oop_hands : equity.ip_hands;
  if (!Array.isArray(hands) || hands.length === 0) {
    return null;
  }
  return hands;
}

/** combo → equity fraction map; skips non-finite values. Keys are {@link comboKey}. */
export function equityByCombo(
  hands: EquityHandLike[] | null | undefined,
): Map<string, number> {
  const map = new Map<string, number>();
  if (!hands) {
    return map;
  }
  for (const hand of hands) {
    const equity = Number(hand.equity);
    if (!hand.combo || !Number.isFinite(equity)) {
      continue;
    }
    map.set(comboKey(hand.combo), equity);
  }
  return map;
}

/**
 * Weighted average check-down equity for a 169-cell.
 * Weights by engine reach when available; otherwise equal among combos with equity.
 * Returns null when no listed combo has a finite equity.
 */
export function groupEquity(
  cell: AggregatedHandCell | null | undefined,
  equityMap: Map<string, number>,
  node: NodePayload | null | undefined,
): number | null {
  if (!cell || !node || equityMap.size === 0) {
    return null;
  }
  const reach = Array.isArray(node.reach) ? (node.reach as number[]) : null;
  let mass = 0;
  let sum = 0;
  let unweightedSum = 0;
  let unweightedCount = 0;
  for (const hand of cell.hands) {
    const equity = equityMap.get(comboKey(hand.combo));
    if (equity == null || !Number.isFinite(equity)) {
      continue;
    }
    const index = (node.combos || []).indexOf(hand.combo);
    const handReach =
      index >= 0 && reach && node.reach_defined
        ? Number(reach[index] ?? 0)
        : null;
    if (handReach != null && Number.isFinite(handReach) && handReach > 0) {
      mass += handReach;
      sum += handReach * equity;
    }
    unweightedSum += equity;
    unweightedCount += 1;
  }
  if (mass > 0) {
    return sum / mass;
  }
  if (unweightedCount > 0) {
    return unweightedSum / unweightedCount;
  }
  return null;
}

export function formatEquityPct(equity: number | null | undefined): string {
  if (equity == null || !Number.isFinite(equity)) {
    return "—";
  }
  return `${(equity * 100).toFixed(0)}`;
}

export function formatEvChip(ev: number | null | undefined): string {
  if (ev == null || !Number.isFinite(ev)) {
    return "—";
  }
  return ev.toFixed(1);
}

/** Build secondary matrix-cell label from overlay prefs (additive to mode). */
export function overlaySubLabel(
  overlay: MatrixCellOverlay,
  ev: number | null,
  equity: number | null,
): string {
  if (overlay === "none") {
    return "";
  }
  if (overlay === "ev") {
    return formatEvChip(ev);
  }
  if (overlay === "equity") {
    return equity == null ? "—" : formatEquityPct(equity);
  }
  // both
  const evText = formatEvChip(ev);
  const eqText = equity == null ? "—" : formatEquityPct(equity);
  return `${evText}/${eqText}`;
}

export function cellShape(row: number, col: number): ComboShape {
  if (row === col) {
    return "pair";
  }
  return row < col ? "suited" : "offsuit";
}

const SUITS_CDHS: CardSuit[] = ["c", "d", "h", "s"];

function suitSymbol(suit: string): string {
  return SUIT_SYMBOLS[suit.toLowerCase() as CardSuit] ?? suit;
}

/** One card inside a GTOWizard-style combo badge (rank + suit glyph). */
export interface ComboBadgeCard {
  rank: string;
  /** Suit letter for four-color deck styling via data-suit (h/d/c/s). */
  suit: CardSuit | string;
  symbol: string;
}

/**
 * Split an engine combo (`AcQc`, `AhKd`) into badge cards for Hands cells.
 * Returns [] when the string is not a 4-char combo.
 */
export function comboBadgeCards(combo: string): ComboBadgeCard[] {
  const key = comboKey(combo);
  if (key.length < 4) {
    return [];
  }
  const cards = [
    { rank: key[0]!.toUpperCase(), suit: key[1]!.toLowerCase() },
    { rank: key[2]!.toUpperCase(), suit: key[3]!.toLowerCase() },
  ];
  return cards.map((card) => {
    const suit = card.suit as CardSuit;
    return {
      rank: card.rank,
      suit,
      symbol: suitSymbol(card.suit),
    };
  });
}

function suitPairLabel(suitA: string, suitB: string, sameSuit: boolean): string {
  if (sameSuit) {
    return suitSymbol(suitA) + suitSymbol(suitA);
  }
  return suitSymbol(suitA) + suitSymbol(suitB);
}

/**
 * Ordered suit-pair slots for a 169-cell (6 pair / 4 suited / 12 offsuit).
 * Keys match engine canonicalize used by {@link combosForCell} in range.ts
 * (higher rank first; pairs higher suit first).
 */
export function expectedComboSlots(
  row: number,
  col: number,
  ranks: readonly string[],
): Array<{ combo: string; label: string }> {
  const highRank = ranks[Math.min(row, col)]!;
  const lowRank = ranks[Math.max(row, col)]!;
  const out: Array<{ combo: string; label: string }> = [];
  if (row === col) {
    for (let i = 0; i < SUITS_CDHS.length; i++) {
      for (let j = i + 1; j < SUITS_CDHS.length; j++) {
        const sHi = SUITS_CDHS[j]!;
        const sLo = SUITS_CDHS[i]!;
        // Pairs: higher suit first (canonicalizeCombo).
        out.push({
          combo: `${highRank}${sHi}${highRank}${sLo}`,
          label: suitPairLabel(sHi, sLo, false),
        });
      }
    }
    return out;
  }
  if (row < col) {
    // Suited
    for (const suit of SUITS_CDHS) {
      out.push({
        combo: `${highRank}${suit}${lowRank}${suit}`,
        label: suitPairLabel(suit, suit, true),
      });
    }
    return out;
  }
  // Offsuit: 12 different-suit pairs (cdhs × cdhs, skipping same suit).
  for (const left of SUITS_CDHS) {
    for (const right of SUITS_CDHS) {
      if (left === right) {
        continue;
      }
      out.push({
        combo: `${highRank}${left}${lowRank}${right}`,
        label: suitPairLabel(left, right, false),
      });
    }
  }
  return out;
}

/** Mixed EV for a single combo under the display basis; null when undefined/zero-mass. */
export function comboEv(
  node: NodePayload | null | undefined,
  values: ActionValuesPayload | null | undefined,
  combo: string,
  basis: EvDisplayBasis = "local",
): number | null {
  const displayed = withEvBasis(values, basis, node?.actions);
  if (!node || !node.reach_defined || !displayed || displayed.pending) {
    return null;
  }
  if (displayed.node_id && node.node_id && displayed.node_id !== node.node_id) {
    return null;
  }
  const combos = displayed.combos || node.combos || [];
  const key = comboKey(combo);
  const valueIndex = combos.findIndex((entry) => comboKey(entry) === key);
  const nodeIndex = (node.combos || []).findIndex((entry) => comboKey(entry) === key);
  if (valueIndex < 0 || nodeIndex < 0) {
    return null;
  }
  if (!displayed.ev_defined?.[valueIndex]) {
    return null;
  }
  const marginal = Number(node.marginal?.[nodeIndex] ?? 0);
  if (!(marginal > 0)) {
    return null;
  }
  const entry = displayed.value?.[valueIndex];
  if (entry == null || Number.isNaN(Number(entry))) {
    return null;
  }
  return Number(entry);
}

/**
 * Break a 169-cell into suit-pair mini-squares with weight / EV / equity.
 * Missing node combos still appear as empty slots so the grid stays 6 (pairs),
 * 4 (suited), or 12 (offsuit).
 */
export function comboBreakdown(
  cell: AggregatedHandCell | null | undefined,
  node: NodePayload | null | undefined,
  values: ActionValuesPayload | null | undefined,
  equityMap: Map<string, number>,
  basis: EvDisplayBasis,
  ranks: readonly string[],
): ComboBreakdownSquare[] {
  if (!cell) {
    return [];
  }
  const slots = expectedComboSlots(cell.row, cell.col, ranks);
  const byCombo = new Map(
    cell.hands.map((hand) => [comboKey(hand.combo), hand] as const),
  );
  const reach = node && Array.isArray(node.reach) ? (node.reach as number[]) : null;

  const actionCount = (node?.actions || []).length;

  return slots.map((slot) => {
    const hand = byCombo.get(comboKey(slot.combo));
    const present = Boolean(hand);
    let reachVal: number | null = null;
    let marginalVal: number | null = null;
    let strategy: number[] | null = null;
    if (present && hand) {
      if (actionCount > 0 && hand.actions.length > 0) {
        const mix = new Array(actionCount).fill(0);
        for (const action of hand.actions) {
          const index = (node?.actions || []).indexOf(action.action);
          if (index >= 0) {
            mix[index] = Math.max(0, Number(action.probability) || 0);
          }
        }
        strategy = mix;
      }
      if (node?.reach_defined) {
        const key = comboKey(slot.combo);
        const index = (node.combos || []).findIndex((entry) => comboKey(entry) === key);
        if (index >= 0) {
          if (reach) {
            const r = Number(reach[index] ?? 0);
            reachVal = Number.isFinite(r) ? r : null;
          }
          const m = Number(node.marginal?.[index] ?? 0);
          marginalVal = Number.isFinite(m) ? m : null;
        }
      }
    }
    const equity = equityMap.get(comboKey(slot.combo));
    return {
      combo: slot.combo,
      label: slot.label,
      reach: reachVal,
      marginal: marginalVal,
      strategy,
      ev: present ? comboEv(node, values, slot.combo, basis) : null,
      equity: equity != null && Number.isFinite(equity) ? equity : null,
      present,
    };
  });
}

/** Height fraction for weight-fill chrome (0–1). */
export function weightFillFraction(
  enabled: boolean,
  inclusion: number | null | undefined,
): number {
  if (!enabled) {
    return 1;
  }
  if (inclusion == null || !Number.isFinite(inclusion)) {
    return 0;
  }
  return Math.max(0, Math.min(1, inclusion));
}
