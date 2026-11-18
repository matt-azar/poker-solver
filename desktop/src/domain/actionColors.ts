/** Stable colors keyed by canonical action identity, not array position. */

import { parseSizedAction, sizeChipsForPotTag } from "./betSizes";

const FOLD = "#5B7FA8";
const CHECK_CALL = "#3F8F6B";
const BET_RAISE = ["#C9843F", "#C45C3A", "#B33A32", "#8E1F28", "#6B1420"];
const ALL_IN = "#5A0F18";

export interface ActionColorMap {
  byIndex: string[];
  byLabel: Record<string, string>;
  legend: Array<{ label: string; color: string }>;
}

export interface MapActionColorsOptions {
  /** Current pot chips — when set, aggressive colors key off pot% (stable across sibling sizes). */
  pot?: number;
  /** Facing amount for `Raise to` pot% identity. */
  toCall?: number;
}

function normalizeLabel(label: string): string {
  return label.trim();
}

function isAllIn(label: string): boolean {
  const lower = label.toLowerCase();
  return lower.includes("all-in") || lower.includes("allin") || /\ball\s*in\b/.test(lower);
}

function isFold(label: string): boolean {
  return label.toLowerCase().startsWith("fold");
}

/** Parse a rough size key so "Bet 50" and "Bet 50%" share an identity bucket. */
export function actionIdentity(label: string): string {
  const normalized = normalizeLabel(label);
  if (isFold(normalized)) {
    return "fold";
  }
  const lower = normalized.toLowerCase();
  if (lower.startsWith("check")) {
    return "check";
  }
  // Calling an all-in is passive — share check/call green, not the all-in red.
  if (lower.startsWith("call")) {
    return "call";
  }
  if (isAllIn(normalized)) {
    return "all-in";
  }
  const match = normalized.match(/^(Bet|Raise)\s+(.+)$/i);
  if (match) {
    return `${match[1].toLowerCase()}:${match[2].replace(/\s+/g, "").toLowerCase()}`;
  }
  // Compact pot tags from Study chrome (`b50`, `r150`).
  const compact = normalized.match(/^([br])(\d+(?:\.\d+)?)/i);
  if (compact) {
    const kind = compact[1]!.toLowerCase() === "r" ? "raise" : "bet";
    return `${kind}:${compact[2]}`;
  }
  return lower;
}

/**
 * Aggressive palette index from pot percent.
 * Keeps e.g. 75% pot on the same swatch whether or not a 33% size is also present.
 */
export function betColorIndexFromPotPct(pct: number): number {
  if (!(pct > 0) || !Number.isFinite(pct)) {
    return 0;
  }
  if (pct <= 30) {
    return 0;
  }
  if (pct <= 45) {
    return 1;
  }
  if (pct <= 65) {
    return 2;
  }
  if (pct <= 90) {
    return 3;
  }
  return Math.min(BET_RAISE.length - 1, 4);
}

function potPctForLabel(label: string, pot: number, toCall: number): number | null {
  if (!(pot > 0)) {
    return null;
  }
  const parsed = parseSizedAction(label);
  if (!parsed || parsed.kind === "call") {
    return null;
  }
  const sizeChips = sizeChipsForPotTag(parsed, toCall);
  if (!(sizeChips >= 0) || !Number.isFinite(sizeChips)) {
    return null;
  }
  return Math.round((sizeChips / pot) * 100);
}

/** Pot-fraction identity (`bet:p75`) when pot is known; else chip/label identity. */
export function actionIdentityWithPot(
  label: string,
  pot?: number,
  toCall = 0,
): string {
  const base = actionIdentity(label);
  if (
    base === "fold" ||
    base === "check" ||
    base === "call" ||
    base === "all-in" ||
    pot == null ||
    !(pot > 0)
  ) {
    return base;
  }
  const pct = potPctForLabel(label, pot, toCall);
  if (pct == null) {
    return base;
  }
  const kind = base.startsWith("raise") ? "raise" : "bet";
  return `${kind}:p${pct}`;
}

function colorForIdentity(id: string, betRank: number): string {
  if (id === "all-in") {
    return ALL_IN;
  }
  if (id === "fold") {
    return FOLD;
  }
  if (id === "check" || id === "call") {
    return CHECK_CALL;
  }
  return BET_RAISE[Math.min(Math.max(betRank, 0), BET_RAISE.length - 1)];
}

export function mapActionColors(
  actions: string[],
  options: MapActionColorsOptions = {},
): ActionColorMap {
  const pot = options.pot;
  const toCall = Number(options.toCall ?? 0);
  const usePot = pot != null && pot > 0;
  const normalized = actions.map(normalizeLabel);
  const identities = normalized.map((label) =>
    usePot ? actionIdentityWithPot(label, pot, toCall) : actionIdentity(label),
  );

  // Without pot: rank by size magnitude among present actions.
  // With pot: index from pot% so 75% keeps its color when smaller sizes appear/disappear.
  const aggressiveIds = [
    ...new Set(
      identities.filter(
        (id) => id !== "fold" && id !== "check" && id !== "call" && id !== "all-in",
      ),
    ),
  ].sort((left, right) => {
    const num = (id: string) => {
      const match = id.match(/:p?([\d.]+)/);
      return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
    };
    const delta = num(left) - num(right);
    return delta !== 0 ? delta : left.localeCompare(right);
  });
  const betRank = new Map(
    aggressiveIds.map((id, index) => {
      if (usePot) {
        const match = id.match(/:p([\d.]+)/);
        const pct = match ? Number(match[1]) : NaN;
        return [id, betColorIndexFromPotPct(pct)] as const;
      }
      return [id, index] as const;
    }),
  );

  const byLabel: Record<string, string> = {};
  const byIndex: string[] = [];
  const legend: Array<{ label: string; color: string }> = [];
  const seen = new Set<string>();

  normalized.forEach((label, index) => {
    const id = identities[index]!;
    const color = colorForIdentity(id, betRank.get(id) ?? 0);
    byLabel[label] = color;
    byIndex.push(color);
    if (!seen.has(id)) {
      seen.add(id);
      legend.push({ label, color });
    }
  });

  return { byIndex, byLabel, legend };
}

