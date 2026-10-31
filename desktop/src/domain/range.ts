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

export function parseSizeList(text: string): number[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map(Number)
    .filter((value) => !Number.isNaN(value));
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

function rankAt(text: string): number {
  const index = ORDER.indexOf(text.toUpperCase());
  if (index < 0) {
    throw new Error("bad rank");
  }
  return index;
}

function setPair(grid: WeightGrid, rank: string, weight: number) {
  const index = rankAt(rank);
  grid[index][index] = weight;
}

function setSuited(grid: WeightGrid, high: string, low: string, weight: number) {
  const left = rankAt(high);
  const right = rankAt(low);
  grid[Math.min(left, right)][Math.max(left, right)] = weight;
}

function setOffsuit(grid: WeightGrid, high: string, low: string, weight: number) {
  const left = rankAt(high);
  const right = rankAt(low);
  grid[Math.max(left, right)][Math.min(left, right)] = weight;
}

function applyShape(grid: WeightGrid, token: string, weight: number): boolean {
  if (token.length === 2 && token[0] === token[1]) {
    setPair(grid, token[0], weight);
    return true;
  }
  if (token.length === 2) {
    setSuited(grid, token[0], token[1], weight);
    setOffsuit(grid, token[0], token[1], weight);
    return true;
  }
  if (token.length === 3 && token[2] === "s") {
    setSuited(grid, token[0], token[1], weight);
    return true;
  }
  if (token.length === 3 && token[2] === "o") {
    setOffsuit(grid, token[0], token[1], weight);
    return true;
  }
  return false;
}

function applyPlus(grid: WeightGrid, token: string, weight: number): boolean {
  if (token.length === 2 && token[0] === token[1]) {
    const start = rankAt(token[0]);
    for (let index = start; index >= 0; index--) {
      grid[index][index] = weight;
    }
    return true;
  }
  if (token.length < 2) {
    return false;
  }
  const shape = token.length === 3 ? token[2] : "";
  const high = rankAt(token[0]);
  const low = rankAt(token[1]);
  const begin = Math.max(high, low);
  const end = Math.min(high, low);
  for (let kicker = begin; kicker > end; kicker--) {
    if (kicker === high) {
      continue;
    }
    if (shape !== "o") {
      grid[Math.min(high, kicker)][Math.max(high, kicker)] = weight;
    }
    if (shape !== "s") {
      grid[Math.max(high, kicker)][Math.min(high, kicker)] = weight;
    }
  }
  return true;
}

function applySpan(grid: WeightGrid, left: string, right: string, weight: number): boolean {
  if (
    left.length === 2 &&
    left[0] === left[1] &&
    right.length === 2 &&
    right[0] === right[1]
  ) {
    const start = rankAt(left[0]);
    const end = rankAt(right[0]);
    for (let index = Math.min(start, end); index <= Math.max(start, end); index++) {
      grid[index][index] = weight;
    }
    return true;
  }
  const shape = left.length === 3 ? left[2] : "";
  const high = rankAt(left[0]);
  const from = rankAt(left[1]);
  const to = rankAt(right[1] || right[0]);
  for (let kicker = Math.min(from, to); kicker <= Math.max(from, to); kicker++) {
    if (kicker === high) {
      continue;
    }
    if (shape !== "o") {
      grid[Math.min(high, kicker)][Math.max(high, kicker)] = weight;
    }
    if (shape !== "s") {
      grid[Math.max(high, kicker)][Math.min(high, kicker)] = weight;
    }
  }
  return true;
}

export function parseRangeText(text: string): WeightGrid {
  const grid = blankGrid();
  text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((rawToken) => {
      let weight = 1;
      let token = rawToken;
      const colon = token.indexOf(":");
      if (colon >= 0) {
        weight = Number(token.slice(colon + 1));
        token = token.slice(0, colon).trim();
      }
      if (!token || Number.isNaN(weight) || weight < 0) {
        return;
      }
      try {
        if (token === "random" || token === "*") {
          for (let row = 0; row < 13; row++) {
            for (let column = 0; column < 13; column++) {
              grid[row][column] = weight;
            }
          }
          return;
        }
        const dash = token.indexOf("-");
        if (dash > 0) {
          applySpan(grid, token.slice(0, dash), token.slice(dash + 1), weight);
          return;
        }
        if (token.endsWith("+")) {
          applyPlus(grid, token.slice(0, -1), weight);
          return;
        }
        applyShape(grid, token, weight);
      } catch {
        return;
      }
    });
  return grid;
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
