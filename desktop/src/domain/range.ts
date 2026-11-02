import { parseSizeToken as parseBetSizeToken } from "./betSizes";
import { RANKS } from "./types";

export type WeightGrid = number[][];
export type WeightSnapshot = { oop: WeightGrid; ip: WeightGrid };

export const RANGE_HISTORY_LIMIT = 50;
const ORDER = "AKQJT98765432";

export function blankGrid(): WeightGrid {
  return Array.from({ length: 13 }, () => Array(13).fill(0));
}

export function cloneWeightGrid(grid: WeightGrid): WeightGrid {
  return grid.map((row) => row.slice());
}

export function weightGridsEqual(left: WeightGrid, right: WeightGrid): boolean {
  for (let row = 0; row < 13; row++) {
    for (let column = 0; column < 13; column++) {
      if (left[row][column] !== right[row][column]) {
        return false;
      }
    }
  }
  return true;
}

export function snapshotWeights(store: WeightSnapshot): WeightSnapshot {
  return {
    oop: cloneWeightGrid(store.oop),
    ip: cloneWeightGrid(store.ip),
  };
}

export function snapshotsEqual(left: WeightSnapshot, right: WeightSnapshot): boolean {
  return weightGridsEqual(left.oop, right.oop) && weightGridsEqual(left.ip, right.ip);
}

export function createRangeHistory(limit = RANGE_HISTORY_LIMIT) {
  const past: WeightSnapshot[] = [];
  const future: WeightSnapshot[] = [];
  return {
    past,
    future,
    push(before: WeightSnapshot) {
      const snap = snapshotWeights(before);
      const top = past[past.length - 1];
      if (top && snapshotsEqual(top, snap)) {
        return false;
      }
      past.push(snap);
      while (past.length > limit) {
        past.shift();
      }
      future.length = 0;
      return true;
    },
    undo(current: WeightSnapshot) {
      if (!past.length) {
        return null;
      }
      const previous = past.pop()!;
      future.push(snapshotWeights(current));
      return previous;
    },
    redo(current: WeightSnapshot) {
      if (!future.length) {
        return null;
      }
      const next = future.pop()!;
      past.push(snapshotWeights(current));
      return next;
    },
    canUndo() {
      return past.length > 0;
    },
    canRedo() {
      return future.length > 0;
    },
  };
}

/** Pio-style pot-size token: `75` → 0.75, `0.5` stays 0.5, `75%` → 0.75. */
export function parseSizeToken(token: string): number | null {
  return parseBetSizeToken(token);
}

export function parseSizeList(text: string): number[] {
  return text
    .split(",")
    .map((part) => parseSizeToken(part))
    .filter((value): value is number => value !== null);
}

/** Absolute numeric list (ICM stacks/payouts) — not Pio percent sizing. Blank tokens are omitted. */
export function parseAbsoluteNumberList(text: string): number[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Number(part))
    .filter((value) => Number.isFinite(value));
}

export function boardCards(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean);
}

export function parseCard(text: string): string | null {
  const raw = text.trim();
  if (raw.length < 2) {
    return null;
  }
  let rank = raw[0].toUpperCase();
  const suit = raw[raw.length - 1].toLowerCase();
  if (raw.toLowerCase().startsWith("10")) {
    rank = "T";
  }
  if (!ORDER.includes(rank) || !"cdhs".includes(suit)) {
    return null;
  }
  return rank + suit;
}

export function boardSet(text: string): Set<string> {
  return new Set(boardCards(text).map(parseCard).filter((card): card is string => !!card));
}

export function pairName(row: number, column: number): string {
  if (row === column) {
    return `${RANKS[row]}${RANKS[column]}`;
  }
  const high = Math.min(row, column);
  const low = Math.max(row, column);
  return `${RANKS[high]}${RANKS[low]}${row < column ? "s" : "o"}`;
}

function trimWeight(weight: number): string {
  return String(Math.round(weight * 1000) / 1000);
}

/**
 * Serialize a 169-grid to class tokens only.
 * Loses suit-specific weights — prefer {@link serializeExactRange} when an
 * ExactRange is available (studyStore paint wiring follow-up).
 */
export function rangeText(grid: WeightGrid): string {
  const parts: string[] = [];
  for (let row = 0; row < 13; row++) {
    for (let column = 0; column < 13; column++) {
      const weight = grid[row][column];
      if (weight <= 0) {
        continue;
      }
      const name = pairName(row, column);
      parts.push(weight >= 0.999 ? name : `${name}:${trimWeight(weight)}`);
    }
  }
  return parts.join(",");
}

/** Canonical suit-specific combo → nonnegative weight (e.g. AsAd → 0.5). */
export type ExactRange = Map<string, number>;

export type RangeTokenError = {
  token: string;
  message: string;
};

export type ExactRangeParse = {
  range: ExactRange;
  errors: RangeTokenError[];
};

export type ExactCellSummary = {
  /** Mean weight across all combos in the 169-cell (absent = 0). */
  average: number;
  /** True when the class has more than one distinct weight (including zeros vs positive). */
  mixed: boolean;
  min: number;
  max: number;
  comboCount: number;
};

const SUITS = ["c", "d", "h", "s"] as const;
const SUIT_ORDER = "cdhs";

export function emptyExactRange(): ExactRange {
  return new Map();
}

export function cloneExactRange(range: ExactRange): ExactRange {
  return new Map(range);
}

/** Engine-style combo key: higher rank first; pairs use higher suit first. */
export function canonicalizeCombo(cardA: string, cardB: string): string {
  const a = parseCard(cardA);
  const b = parseCard(cardB);
  if (!a || !b) {
    throw new Error("bad card");
  }
  if (a === b) {
    throw new Error("a combo cannot repeat a card");
  }
  const rankA = ORDER.indexOf(a[0]);
  const rankB = ORDER.indexOf(b[0]);
  const suitA = SUIT_ORDER.indexOf(a[1]);
  const suitB = SUIT_ORDER.indexOf(b[1]);
  let first = a;
  let second = b;
  if (rankA > rankB || (rankA === rankB && suitA < suitB)) {
    first = b;
    second = a;
  }
  return first + second;
}

function readCardPrefix(
  text: string,
  start: number,
): { card: string; next: number } | null {
  let index = start;
  while (index < text.length && /\s/.test(text[index]!)) {
    index += 1;
  }
  if (index >= text.length) {
    return null;
  }
  let rank = text[index]!.toUpperCase();
  let consumed = 1;
  if (text.toLowerCase().startsWith("10", index)) {
    rank = "T";
    consumed = 2;
  }
  const suitIndex = index + consumed;
  if (suitIndex >= text.length) {
    return null;
  }
  const suit = text[suitIndex]!.toLowerCase();
  if (!ORDER.includes(rank) || !SUIT_ORDER.includes(suit)) {
    return null;
  }
  return { card: rank + suit, next: suitIndex + 1 };
}

/** Parse a suit-specific token like AsAd / As Ad into a canonical combo key. */
export function parseExactComboToken(token: string): string | null {
  const first = readCardPrefix(token, 0);
  if (!first) {
    return null;
  }
  const second = readCardPrefix(token, first.next);
  if (!second) {
    return null;
  }
  let index = second.next;
  while (index < token.length && /\s/.test(token[index]!)) {
    index += 1;
  }
  if (index !== token.length) {
    return null;
  }
  try {
    return canonicalizeCombo(first.card, second.card);
  } catch {
    return null;
  }
}

export function combosForCell(row: number, column: number): string[] {
  const high = RANKS[Math.min(row, column)]!;
  const low = RANKS[Math.max(row, column)]!;
  const out: string[] = [];
  if (row === column) {
    for (let i = 0; i < SUITS.length; i++) {
      for (let j = i + 1; j < SUITS.length; j++) {
        out.push(canonicalizeCombo(high + SUITS[j]!, high + SUITS[i]!));
      }
    }
    return out;
  }
  const suited = row < column;
  for (const left of SUITS) {
    for (const right of SUITS) {
      if (suited ? left !== right : left === right) {
        continue;
      }
      out.push(canonicalizeCombo(high + left, low + right));
    }
  }
  return out;
}

export function combosForClass(className: string): string[] | null {
  const coords = classCoords(className);
  if (!coords) {
    return null;
  }
  return combosForCell(coords.row, coords.column);
}

function classCoords(className: string): { row: number; column: number } | null {
  const token = className.trim();
  if (token.length === 2 && token[0] === token[1]) {
    const index = ORDER.indexOf(token[0]!.toUpperCase());
    if (index < 0) {
      return null;
    }
    return { row: index, column: index };
  }
  if (token.length === 3 && (token[2] === "s" || token[2] === "o")) {
    const high = ORDER.indexOf(token[0]!.toUpperCase());
    const low = ORDER.indexOf(token[1]!.toUpperCase());
    if (high < 0 || low < 0 || high === low) {
      return null;
    }
    if (token[2] === "s") {
      return { row: Math.min(high, low), column: Math.max(high, low) };
    }
    return { row: Math.max(high, low), column: Math.min(high, low) };
  }
  return null;
}

function setCellCombos(
  range: ExactRange,
  row: number,
  column: number,
  weight: number,
) {
  for (const combo of combosForCell(row, column)) {
    if (weight <= 0) {
      range.delete(combo);
    } else {
      range.set(combo, weight);
    }
  }
}

function setPairExact(range: ExactRange, rank: string, weight: number) {
  const index = rankAt(rank);
  setCellCombos(range, index, index, weight);
}

function setSuitedExact(
  range: ExactRange,
  high: string,
  low: string,
  weight: number,
) {
  const left = rankAt(high);
  const right = rankAt(low);
  setCellCombos(range, Math.min(left, right), Math.max(left, right), weight);
}

function setOffsuitExact(
  range: ExactRange,
  high: string,
  low: string,
  weight: number,
) {
  const left = rankAt(high);
  const right = rankAt(low);
  setCellCombos(range, Math.max(left, right), Math.min(left, right), weight);
}

function isRankChar(character: string | undefined): boolean {
  return !!character && ORDER.includes(character.toUpperCase());
}

function applyShapeExact(
  range: ExactRange,
  token: string,
  weight: number,
): boolean {
  if (token.length === 2 && token[0] === token[1]) {
    if (!isRankChar(token[0])) {
      return false;
    }
    setPairExact(range, token[0]!, weight);
    return true;
  }
  if (token.length === 2) {
    if (!isRankChar(token[0]) || !isRankChar(token[1])) {
      return false;
    }
    setSuitedExact(range, token[0]!, token[1]!, weight);
    setOffsuitExact(range, token[0]!, token[1]!, weight);
    return true;
  }
  if (token.length === 3 && token[2] === "s") {
    if (!isRankChar(token[0]) || !isRankChar(token[1])) {
      return false;
    }
    setSuitedExact(range, token[0]!, token[1]!, weight);
    return true;
  }
  if (token.length === 3 && token[2] === "o") {
    if (!isRankChar(token[0]) || !isRankChar(token[1])) {
      return false;
    }
    setOffsuitExact(range, token[0]!, token[1]!, weight);
    return true;
  }
  return false;
}

function applyPlusExact(
  range: ExactRange,
  token: string,
  weight: number,
): boolean {
  if (token.length === 2 && token[0] === token[1]) {
    const start = rankAt(token[0]!);
    for (let index = start; index >= 0; index--) {
      setCellCombos(range, index, index, weight);
    }
    return true;
  }
  if (token.length < 2) {
    return false;
  }
  const shape = token.length === 3 ? token[2] : "";
  const high = rankAt(token[0]!);
  const low = rankAt(token[1]!);
  const begin = Math.max(high, low);
  const end = Math.min(high, low);
  for (let kicker = begin; kicker > end; kicker--) {
    if (kicker === high) {
      continue;
    }
    if (shape !== "o") {
      setCellCombos(range, Math.min(high, kicker), Math.max(high, kicker), weight);
    }
    if (shape !== "s") {
      setCellCombos(range, Math.max(high, kicker), Math.min(high, kicker), weight);
    }
  }
  return true;
}

function applySpanExact(
  range: ExactRange,
  left: string,
  right: string,
  weight: number,
): boolean {
  if (
    left.length === 2 &&
    left[0] === left[1] &&
    right.length === 2 &&
    right[0] === right[1]
  ) {
    const start = rankAt(left[0]!);
    const end = rankAt(right[0]!);
    for (let index = Math.min(start, end); index <= Math.max(start, end); index++) {
      setCellCombos(range, index, index, weight);
    }
    return true;
  }
  const shape = left.length === 3 ? left[2] : "";
  const high = rankAt(left[0]!);
  const from = rankAt(left[1]!);
  const to = rankAt(right[1] || right[0]!);
  for (let kicker = Math.min(from, to); kicker <= Math.max(from, to); kicker++) {
    if (kicker === high) {
      continue;
    }
    if (shape !== "o") {
      setCellCombos(range, Math.min(high, kicker), Math.max(high, kicker), weight);
    }
    if (shape !== "s") {
      setCellCombos(range, Math.max(high, kicker), Math.min(high, kicker), weight);
    }
  }
  return true;
}

function applyExactToken(
  range: ExactRange,
  rawToken: string,
): RangeTokenError | null {
  let weight = 1;
  let token = rawToken.trim();
  const colon = token.indexOf(":");
  if (colon >= 0) {
    weight = Number(token.slice(colon + 1));
    token = token.slice(0, colon).trim();
  }
  if (!token) {
    return { token: rawToken, message: "empty range token" };
  }
  if (Number.isNaN(weight) || weight < 0 || !Number.isFinite(weight)) {
    return { token: rawToken, message: "range weight must be a nonnegative number" };
  }
  try {
    if (token === "random" || token === "*") {
      for (let row = 0; row < 13; row++) {
        for (let column = 0; column < 13; column++) {
          setCellCombos(range, row, column, weight);
        }
      }
      return null;
    }
    const exact = parseExactComboToken(token);
    if (exact) {
      if (weight <= 0) {
        range.delete(exact);
      } else {
        range.set(exact, weight);
      }
      return null;
    }
    const dash = token.indexOf("-");
    if (dash > 0) {
      if (!applySpanExact(range, token.slice(0, dash), token.slice(dash + 1), weight)) {
        return { token: rawToken, message: `unsupported range token: ${token}` };
      }
      return null;
    }
    if (token.endsWith("+")) {
      if (!applyPlusExact(range, token.slice(0, -1), weight)) {
        return { token: rawToken, message: `unsupported range token: ${token}` };
      }
      return null;
    }
    if (!applyShapeExact(range, token, weight)) {
      return { token: rawToken, message: `unsupported range token: ${token}` };
    }
    return null;
  } catch (error) {
    return {
      token: rawToken,
      message: error instanceof Error ? error.message : `unsupported range token: ${token}`,
    };
  }
}

/** Parse class tokens and suit-specific combos into the canonical ExactRange. */
export function parseExactRange(text: string): ExactRangeParse {
  const range = emptyExactRange();
  const errors: RangeTokenError[] = [];
  text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((rawToken) => {
      const error = applyExactToken(range, rawToken);
      if (error) {
        errors.push(error);
      }
    });
  return { range, errors };
}

/**
 * Paint every combo in a 169-class to `weight`, leaving all other exact combos
 * untouched. `className` is AA / AKs / AKo (see {@link pairName}).
 */
export function paintClass(
  range: ExactRange,
  className: string,
  weight: number,
): ExactRange {
  const next = cloneExactRange(range);
  const combos = combosForClass(className);
  if (!combos) {
    throw new Error(`unknown hand class: ${className}`);
  }
  if (!(weight >= 0) || !Number.isFinite(weight)) {
    throw new Error("paint weight must be a nonnegative number");
  }
  for (const combo of combos) {
    if (weight <= 0) {
      next.delete(combo);
    } else {
      next.set(combo, weight);
    }
  }
  return next;
}

export function paintClassAt(
  range: ExactRange,
  row: number,
  column: number,
  weight: number,
): ExactRange {
  return paintClass(range, pairName(row, column), weight);
}

export function exactCellSummary(
  range: ExactRange,
  row: number,
  column: number,
): ExactCellSummary {
  const combos = combosForCell(row, column);
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  const distinct = new Set<number>();
  for (const combo of combos) {
    const weight = range.get(combo) ?? 0;
    sum += weight;
    min = Math.min(min, weight);
    max = Math.max(max, weight);
    distinct.add(weight);
  }
  if (!combos.length) {
    return { average: 0, mixed: false, min: 0, max: 0, comboCount: 0 };
  }
  return {
    average: sum / combos.length,
    mixed: distinct.size > 1,
    min: Number.isFinite(min) ? min : 0,
    max,
    comboCount: combos.length,
  };
}

/** Derive the 169-cell display grid (per-class average inclusion weight). */
export function weightsFromExact(range: ExactRange): WeightGrid {
  const grid = blankGrid();
  for (let row = 0; row < 13; row++) {
    for (let column = 0; column < 13; column++) {
      grid[row]![column] = exactCellSummary(range, row, column).average;
    }
  }
  return grid;
}

function formatExactToken(combo: string, weight: number): string {
  return weight >= 0.999 ? combo : `${combo}:${trimWeight(weight)}`;
}

function formatClassToken(name: string, weight: number): string {
  return weight >= 0.999 ? name : `${name}:${trimWeight(weight)}`;
}

/**
 * Serialize ExactRange. Uniform 169-classes collapse to AA/AKs/AKo tokens;
 * mixed or partial classes keep suit-specific combo tokens so untouched
 * exact weights survive a later paintClass round-trip.
 */
export function serializeExactRange(range: ExactRange): string {
  const parts: string[] = [];
  for (let row = 0; row < 13; row++) {
    for (let column = 0; column < 13; column++) {
      const combos = combosForCell(row, column);
      const weights = combos.map((combo) => range.get(combo) ?? 0);
      const positive = weights.filter((weight) => weight > 0);
      if (!positive.length) {
        continue;
      }
      const name = pairName(row, column);
      const allSame =
        weights.length > 0 && weights.every((weight) => weight === weights[0]);
      if (allSame && weights[0]! > 0) {
        parts.push(formatClassToken(name, weights[0]!));
        continue;
      }
      const ordered = combos
        .map((combo, index) => ({ combo, weight: weights[index]! }))
        .filter((entry) => entry.weight > 0)
        .sort((left, right) => left.combo.localeCompare(right.combo));
      for (const entry of ordered) {
        parts.push(formatExactToken(entry.combo, entry.weight));
      }
    }
  }
  return parts.join(",");
}

/**
 * Compatibility helper for studyStore: parse → paint one class → serialize,
 * preserving suit-specific weights outside that class.
 */
export function applyPaintPreservingExact(
  rangeTextValue: string,
  className: string,
  weight: number,
): { text: string; range: ExactRange; grid: WeightGrid; errors: RangeTokenError[] } {
  const parsed = parseExactRange(rangeTextValue);
  const range = paintClass(parsed.range, className, weight);
  return {
    text: serializeExactRange(range),
    range,
    grid: weightsFromExact(range),
    errors: parsed.errors,
  };
}

export function applyPaintAtPreservingExact(
  rangeTextValue: string,
  row: number,
  column: number,
  weight: number,
): { text: string; range: ExactRange; grid: WeightGrid; errors: RangeTokenError[] } {
  return applyPaintPreservingExact(rangeTextValue, pairName(row, column), weight);
}

/** Both-seat ExactRange snapshot for paint/set/clear/undo history. */
export type ExactPairSnapshot = { oop: ExactRange; ip: ExactRange };

export function exactPairFromTexts(oopText: string, ipText: string): ExactPairSnapshot {
  return {
    oop: parseExactRange(oopText).range,
    ip: parseExactRange(ipText).range,
  };
}

export function cloneExactPair(store: ExactPairSnapshot): ExactPairSnapshot {
  return {
    oop: cloneExactRange(store.oop),
    ip: cloneExactRange(store.ip),
  };
}

function exactRangesEqual(left: ExactRange, right: ExactRange): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [combo, weight] of left) {
    if (right.get(combo) !== weight) {
      return false;
    }
  }
  return true;
}

export function exactPairsEqual(left: ExactPairSnapshot, right: ExactPairSnapshot): boolean {
  return exactRangesEqual(left.oop, right.oop) && exactRangesEqual(left.ip, right.ip);
}

export function weightsFromExactPair(store: ExactPairSnapshot): WeightSnapshot {
  return {
    oop: weightsFromExact(store.oop),
    ip: weightsFromExact(store.ip),
  };
}

export function textsFromExactPair(store: ExactPairSnapshot): { oop: string; ip: string } {
  return {
    oop: serializeExactRange(store.oop),
    ip: serializeExactRange(store.ip),
  };
}

/** Undo/redo stack keyed by ExactRange pairs (not aggregate 169-grids). */
export function createExactRangeHistory(limit = RANGE_HISTORY_LIMIT) {
  const past: ExactPairSnapshot[] = [];
  const future: ExactPairSnapshot[] = [];
  return {
    past,
    future,
    push(before: ExactPairSnapshot) {
      const snap = cloneExactPair(before);
      const top = past[past.length - 1];
      if (top && exactPairsEqual(top, snap)) {
        return false;
      }
      past.push(snap);
      while (past.length > limit) {
        past.shift();
      }
      future.length = 0;
      return true;
    },
    undo(current: ExactPairSnapshot) {
      if (!past.length) {
        return null;
      }
      const previous = past.pop()!;
      future.push(cloneExactPair(current));
      return previous;
    },
    redo(current: ExactPairSnapshot) {
      if (!future.length) {
        return null;
      }
      const next = future.pop()!;
      past.push(cloneExactPair(current));
      return next;
    },
    canUndo() {
      return past.length > 0;
    },
    canRedo() {
      return future.length > 0;
    },
    clear() {
      past.length = 0;
      future.length = 0;
    },
  };
}

function rankAt(text: string): number {
  const index = ORDER.indexOf(text.toUpperCase());
  if (index < 0) {
    throw new Error("bad rank");
  }
  return index;
}

/**
 * 169-grid parse for studyStore-compatible callers.
 * Exact suit tokens are averaged into their class cell via {@link weightsFromExact}.
 * Unsupported tokens are skipped (same silent behavior as before). Prefer
 * {@link parseExactRange} + {@link serializeExactRange} / {@link applyPaintPreservingExact}
 * when suit-specific fidelity must survive painting.
 */
export function parseRangeText(text: string): WeightGrid {
  return weightsFromExact(parseExactRange(text).range);
}

export function liveCombos(
  row: number,
  column: number,
  blocked: Set<string>,
): { total: number; live: number } {
  const high = RANKS[Math.min(row, column)];
  const low = RANKS[Math.max(row, column)];
  const suits = ["c", "d", "h", "s"];
  let total = 0;
  let live = 0;
  if (row === column) {
    for (let i = 0; i < suits.length; i++) {
      for (let j = i + 1; j < suits.length; j++) {
        total += 1;
        const a = high + suits[i];
        const b = high + suits[j];
        if (!blocked.has(a) && !blocked.has(b)) {
          live += 1;
        }
      }
    }
    return { total, live };
  }
  const suited = row < column;
  for (const left of suits) {
    for (const right of suits) {
      if (suited ? left !== right : left === right) {
        continue;
      }
      total += 1;
      if (!blocked.has(high + left) && !blocked.has(low + right)) {
        live += 1;
      }
    }
  }
  return { total, live };
}

export function comboCount(grid: WeightGrid, boardText: string): number {
  const blocked = boardSet(boardText);
  let count = 0;
  for (let row = 0; row < 13; row++) {
    for (let column = 0; column < 13; column++) {
      if (grid[row][column] <= 0) {
        continue;
      }
      count += liveCombos(row, column, blocked).live * Math.min(grid[row][column], 1);
    }
  }
  return count;
}
