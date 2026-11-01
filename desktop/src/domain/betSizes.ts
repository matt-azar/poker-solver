/**
 * Pio-style bet-size parsing and Study display helpers.
 *
 * Build inputs use pot percentages (`75` → 0.75 pot). Engine labels are chip
 * amounts (`Bet 75`); Study display can show pot tag + chips.
 */

export type BetSizeDisplayMode = "both" | "pot" | "chips";

export interface ParsedSizeToken {
  /** Pot fraction for the engine (0.75 = 75% pot). */
  fraction: number;
  /** True when the token was geometric `e` / `Ne`. */
  geometric: boolean;
  /** Multiplier on the geometric size (`3e` → 3). */
  geometricMultiple: number;
}

/** Streets remaining for geometric sizing from a public board length. */
export function streetsRemaining(boardLen: number): number {
  if (boardLen <= 3) {
    return 3;
  }
  if (boardLen === 4) {
    return 2;
  }
  return 1;
}

/**
 * Pio geometric pot fraction: ((1 + 2E/P)^(1/S) - 1) / 2
 * E = effective stack, P = pot, S = streets left.
 */
export function geometricPotFraction(
  pot: number,
  stack: number,
  streetsLeft: number,
): number {
  if (!(pot > 0) || !(stack >= 0) || streetsLeft < 1) {
    return 0;
  }
  return (Math.pow(1 + (2 * stack) / pot, 1 / streetsLeft) - 1) / 2;
}

/**
 * Parse one size token.
 * - `75` / `75%` → 0.75
 * - `150` → 1.5
 * - `0.5` → 0.5 (explicit fraction)
 * - `e` / `2e` / `3e` → geometric (multiple)
 * - `20c` → fixed chips as negative engine size
 */
export function parseSizeTokenDetailed(token: string): ParsedSizeToken | null {
  const raw = token.trim().toLowerCase();
  if (!raw) {
    return null;
  }

  const geo = raw.match(/^(\d+(?:\.\d+)?)?e$/);
  if (geo) {
    const multiple = geo[1] ? Number(geo[1]) : 1;
    if (!Number.isFinite(multiple) || multiple <= 0) {
      return null;
    }
    return { fraction: 0, geometric: true, geometricMultiple: multiple };
  }

  if (raw.endsWith("%")) {
    const pct = Number(raw.slice(0, -1).trim());
    if (!Number.isFinite(pct)) {
      return null;
    }
    return { fraction: pct / 100, geometric: false, geometricMultiple: 1 };
  }

  if (raw.endsWith("c")) {
    const chips = Number(raw.slice(0, -1).trim());
    if (!Number.isFinite(chips)) {
      return null;
    }
    return { fraction: -Math.abs(chips), geometric: false, geometricMultiple: 1 };
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return null;
  }
  // Explicit fraction in (0, 1]: keep. Integers and values > 1: Pio percent.
  if (value > 1 || Number.isInteger(value)) {
    return { fraction: value / 100, geometric: false, geometricMultiple: 1 };
  }
  return { fraction: value, geometric: false, geometricMultiple: 1 };
}

export function parseSizeToken(token: string): number | null {
  const parsed = parseSizeTokenDetailed(token);
  return parsed && !parsed.geometric ? parsed.fraction : null;
}

export interface ResolveSizeOptions {
  pot: number;
  stack: number;
  boardLen: number;
  /** When true, engine geometric flag is on — bare `e` tokens are dropped (engine adds geo). */
  geometricFlag: boolean;
  mergeThresholdPct?: number;
}

/**
 * Resolve a comma/space size list to engine pot fractions, expanding `e`/`Ne`
 * when the geometric checkbox is off, then optionally merging near sizes.
 */
export function resolveSizeList(
  text: string,
  options: ResolveSizeOptions,
): number[] {
  const parts = text.split(/[,]+/).map((part) => part.trim()).filter(Boolean);
  const streets = streetsRemaining(options.boardLen);
  const geo = geometricPotFraction(options.pot, options.stack, streets);
  const out: number[] = [];

  for (const part of parts) {
    const parsed = parseSizeTokenDetailed(part);
    if (!parsed) {
      continue;
    }
    if (parsed.geometric) {
      if (options.geometricFlag) {
        // Engine already injects one geometric size; skip token.
        continue;
      }
      out.push(geo * parsed.geometricMultiple);
      continue;
    }
    out.push(parsed.fraction);
  }

  return mergeSizeFractions(out, options.pot, options.mergeThresholdPct ?? 0);
}

/** Merge fractions whose rounded chip amounts fall within threshold % of each other. */
export function mergeSizeFractions(
  fractions: number[],
  pot: number,
  thresholdPct: number,
): number[] {
  if (!(thresholdPct > 0) || fractions.length < 2) {
    return fractions.slice().sort((a, b) => a - b);
  }
  const threshold = thresholdPct / 100;
  const sorted = fractions
    .map((fraction) => ({
      fraction,
      chips:
        fraction < 0
          ? Math.abs(fraction)
          : Math.max(0, Math.round(fraction * pot)),
    }))
    .sort((a, b) => a.chips - b.chips || a.fraction - b.fraction);

  const merged: typeof sorted = [];
  for (const entry of sorted) {
    const prev = merged[merged.length - 1];
    if (!prev) {
      merged.push(entry);
      continue;
    }
    const denom = Math.max(prev.chips, entry.chips, 1);
    if (Math.abs(prev.chips - entry.chips) / denom <= threshold) {
      // Keep the larger fraction (more aggressive size) when collapsing.
      if (entry.fraction > prev.fraction) {
        merged[merged.length - 1] = entry;
      }
      continue;
    }
    merged.push(entry);
  }
  return merged.map((entry) => entry.fraction);
}

/** Compact pot tag like `b75` / `r150` from an engine action label + pot. */
export function potTagFromLabel(
  label: string,
  pot: number,
): string | null {
  const match = label.trim().match(/^(Bet|Raise|Donk)\s+(-?\d+(?:\.\d+)?)/i);
  if (!match || !(pot > 0)) {
    return null;
  }
  const chips = Number(match[2]);
  if (!Number.isFinite(chips)) {
    return null;
  }
  const pct = Math.round((Math.abs(chips) / pot) * 100);
  const kind = match[1].toLowerCase().startsWith("r") ? "r" : "b";
  return `${kind}${pct}`;
}

/** Format absolute chips with one decimal place. */
export function formatChips1(chips: number): string {
  return chips.toFixed(1);
}

export function chipsFromLabel(label: string): number | null {
  const match = label.trim().match(/^(?:Bet|Raise|Donk|Call)\s+(-?\d+(?:\.\d+)?)/i);
  if (!match) {
    return null;
  }
  const chips = Number(match[1]);
  return Number.isFinite(chips) ? chips : null;
}

/**
 * Display label for Study action chips.
 * Default `both`: `b75 · 75.0` with frequency rendered separately.
 */
export function formatActionDisplay(
  label: string,
  pot: number,
  mode: BetSizeDisplayMode = "both",
): { primary: string; secondary: string | null } {
  const trimmed = label.trim();
  if (/^(check|fold|call)$/i.test(trimmed) || /^call\b/i.test(trimmed)) {
    return { primary: trimmed, secondary: null };
  }
  if (/all[\s-]*in/i.test(trimmed)) {
    return { primary: trimmed, secondary: null };
  }
  const chips = chipsFromLabel(trimmed);
  const tag = potTagFromLabel(trimmed, pot);
  if (chips == null) {
    return { primary: trimmed, secondary: null };
  }
  const chipText = formatChips1(chips);
  if (mode === "chips") {
    return { primary: chipText, secondary: null };
  }
  if (mode === "pot") {
    return { primary: tag ?? trimmed, secondary: null };
  }
  // both
  if (tag) {
    return { primary: tag, secondary: chipText };
  }
  return { primary: trimmed, secondary: chipText };
}
