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
  /** True when the token was a raise multiple (`2x` / `2.5x`). */
  raiseMultiple: boolean;
  /** Facing-bet multiple (`2x` → 2). */
  raiseMultipleValue: number;
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
 * - `2x` / `2.5x` → raise multiple of the bet being faced
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
    return {
      fraction: 0,
      geometric: true,
      geometricMultiple: multiple,
      raiseMultiple: false,
      raiseMultipleValue: 0,
    };
  }

  const raiseX = raw.match(/^(\d+(?:\.\d+)?)x$/);
  if (raiseX) {
    const multiple = Number(raiseX[1]);
    if (!Number.isFinite(multiple) || multiple <= 0) {
      return null;
    }
    return {
      fraction: 0,
      geometric: false,
      geometricMultiple: 1,
      raiseMultiple: true,
      raiseMultipleValue: multiple,
    };
  }

  if (raw.endsWith("%")) {
    const pct = Number(raw.slice(0, -1).trim());
    if (!Number.isFinite(pct)) {
      return null;
    }
    return {
      fraction: pct / 100,
      geometric: false,
      geometricMultiple: 1,
      raiseMultiple: false,
      raiseMultipleValue: 0,
    };
  }

  if (raw.endsWith("c")) {
    const chips = Number(raw.slice(0, -1).trim());
    if (!Number.isFinite(chips)) {
      return null;
    }
    return {
      fraction: -Math.abs(chips),
      geometric: false,
      geometricMultiple: 1,
      raiseMultiple: false,
      raiseMultipleValue: 0,
    };
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return null;
  }
  // Explicit fraction in (0, 1]: keep. Integers and values > 1: Pio percent.
  if (value > 1 || Number.isInteger(value)) {
    return {
      fraction: value / 100,
      geometric: false,
      geometricMultiple: 1,
      raiseMultiple: false,
      raiseMultipleValue: 0,
    };
  }
  return {
    fraction: value,
    geometric: false,
    geometricMultiple: 1,
    raiseMultiple: false,
    raiseMultipleValue: 0,
  };
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
 * Raise multiples (`2x`) are ignored here — use {@link resolveRaiseSizeList}.
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
    if (!parsed || parsed.raiseMultiple) {
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

export interface ResolvedRaiseSizes {
  /** Pot-fraction / fixed-chip raise sizes for the engine. */
  fractions: number[];
  /** Facing-bet multiples (`2x` → 2) for `*_raise_multiples`. */
  multiples: number[];
}

/**
 * Resolve a raise-size field: pot % (`50`, `100`) and facing multiples (`2x`).
 * Blank text → empty fractions and multiples (no copy from bet sizes).
 */
export function resolveRaiseSizeList(
  text: string,
  options: ResolveSizeOptions,
): ResolvedRaiseSizes {
  const parts = text.split(/[,]+/).map((part) => part.trim()).filter(Boolean);
  const streets = streetsRemaining(options.boardLen);
  const geo = geometricPotFraction(options.pot, options.stack, streets);
  const fractions: number[] = [];
  const multiples: number[] = [];

  for (const part of parts) {
    const parsed = parseSizeTokenDetailed(part);
    if (!parsed) {
      continue;
    }
    if (parsed.raiseMultiple) {
      multiples.push(parsed.raiseMultipleValue);
      continue;
    }
    if (parsed.geometric) {
      if (options.geometricFlag) {
        continue;
      }
      fractions.push(geo * parsed.geometricMultiple);
      continue;
    }
    fractions.push(parsed.fraction);
  }

  return {
    fractions: mergeSizeFractions(
      fractions,
      options.pot,
      options.mergeThresholdPct ?? 0,
    ),
    multiples: [...multiples].sort((a, b) => a - b),
  };
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

/** Absolute chip amount with an explicit unit suffix (never a frequency). */
export function formatChipsWithUnit(chips: number): string {
  return `${formatChips1(chips)} chips`;
}

/**
 * Strategy frequency as a percent string (`31.9%`).
 * Kept separate from pot tags like `b50` so size never reads as frequency.
 */
export function formatFrequencyPct(
  frequency: number | null | undefined,
  digits = 1,
): string | null {
  if (frequency == null || !Number.isFinite(frequency)) {
    return null;
  }
  return `${(Math.max(0, frequency) * 100).toFixed(digits)}%`;
}

export function chipsFromLabel(label: string): number | null {
  const match = label.trim().match(/^(?:Bet|Raise|Donk|Call)\s+(-?\d+(?:\.\d+)?)/i);
  if (!match) {
    return null;
  }
  const chips = Number(match[1]);
  return Number.isFinite(chips) ? chips : null;
}

export interface ActionDisplayParts {
  /** Compact pot tag (`b50`) or passive label (`Check`). Never a bare percent. */
  primary: string;
  /** Optional chips with units (`50.0 chips`), or null. */
  secondary: string | null;
  /** Engine/raw label for tooltips and a11y. */
  raw: string;
  /** Compact pot tag when applicable (`b50`), else null. */
  potTag: string | null;
}

/**
 * Display label for Study action blocks.
 *
 * Hard policy: a 50% pot bet stays primary `b50` (not `Bet 50%`). Frequency is
 * rendered separately via `formatFrequencyPct`. Absolute chips are optional
 * secondary/tooltip text with an explicit `chips` unit.
 */
export function formatActionDisplay(
  label: string,
  pot: number,
  mode: BetSizeDisplayMode = "both",
): ActionDisplayParts {
  const trimmed = label.trim();
  const potTag = potTagFromLabel(trimmed, pot);
  if (/^(check|fold|call)$/i.test(trimmed) || /^call\b/i.test(trimmed)) {
    return { primary: trimmed, secondary: null, raw: trimmed, potTag: null };
  }
  if (/all[\s-]*in/i.test(trimmed)) {
    return { primary: trimmed, secondary: null, raw: trimmed, potTag };
  }
  const chips = chipsFromLabel(trimmed);
  if (chips == null) {
    return { primary: trimmed, secondary: null, raw: trimmed, potTag };
  }
  const chipText = formatChipsWithUnit(chips);
  if (mode === "chips") {
    return { primary: chipText, secondary: null, raw: trimmed, potTag };
  }
  if (mode === "pot") {
    return {
      primary: potTag ?? trimmed,
      secondary: null,
      raw: trimmed,
      potTag,
    };
  }
  // both — pot tag primary, chips secondary with units
  if (potTag) {
    return { primary: potTag, secondary: chipText, raw: trimmed, potTag };
  }
  return { primary: trimmed, secondary: chipText, raw: trimmed, potTag: null };
}

/** Tooltip / title text: primary, optional chips, raw engine label. */
export function formatActionTooltip(
  label: string,
  pot: number,
  mode: BetSizeDisplayMode = "both",
): string {
  const display = formatActionDisplay(label, pot, mode);
  const parts = [display.primary];
  if (display.secondary) {
    parts.push(display.secondary);
  } else if (display.potTag && mode === "pot") {
    const chips = chipsFromLabel(display.raw);
    if (chips != null) {
      parts.push(formatChipsWithUnit(chips));
    }
  }
  if (display.raw !== display.primary) {
    parts.push(display.raw);
  }
  return parts.join(" · ");
}
