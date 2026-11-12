/**
 * Pio-style bet-size parsing and Study Build display helpers.
 *
 * Build inputs use pot percentages (`75` → 0.75 pot). Engine labels are chip
 * amounts (`Bet 75`); Study display can show pot tag + chips.
 *
 * Numeric encoding mirrors `include/game/size_spec.hpp`. A `number[]` entry is
 * one of: pot fraction (≥ 0), fixed chips (−chips in (−1e8, 0)), all-in (−1e9),
 * geometric (−2e9 − N streets), raise multiple (−3e9 − m), or explicit-empty
 * (−4e9). Prefer {@link formatEngineSpec} / {@link encodeBetList} over reading
 * raw numbers in UI code.
 *
 * Study Build blank bet = check-only; blank raise = no pot-fraction raises
 * (same as `-`; list sizes or `2.5x` explicitly — never copy that street's bets);
 * blank donk = no lead (donk* checkboxes are ignored when text is blank).
 * Size lists are comma-delimited; unrecognized tokens are errors, never skipped.
 * Engine JSON still distinguishes inherit (`[]`) from explicit-empty (`[-4e9]`).
 * Import helpers below resolve inheritance into editable text so rebuild keeps
 * the same tree.
 */

export type BetSizeDisplayMode = "both" | "pot" | "chips";

export interface ParsedSizeToken {
  /** Pot fraction for the engine (0.75 = 75% pot). */
  fraction: number;
  /** True when the token was geometric `e` / `Ne`. */
  geometric: boolean;
  /**
   * Streets encoded by a geometric token. Bare `e` → 0 (engine picks streets
   * left at the node). `2e` → 2 equal pot-fraction bets from the current pot.
   */
  geometricStreets: number;
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
 * - `0.5%` → 0.005
 * - `e` / `2e` / `3e` → geometric (streets; bare `e` encodes 0)
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
    if (geo[1] === undefined) {
      return {
        fraction: 0,
        geometric: true,
        geometricStreets: 0,
        raiseMultiple: false,
        raiseMultipleValue: 0,
      };
    }
    const streets = Number(geo[1]);
    if (!Number.isInteger(streets) || streets <= 0 || streets > 100) {
      return null;
    }
    return {
      fraction: 0,
      geometric: true,
      geometricStreets: streets,
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
      geometricStreets: 0,
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
      geometricStreets: 0,
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
      geometricStreets: 0,
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
      geometricStreets: 0,
      raiseMultiple: false,
      raiseMultipleValue: 0,
    };
  }
  return {
    fraction: value,
    geometric: false,
    geometricStreets: 0,
    raiseMultiple: false,
    raiseMultipleValue: 0,
  };
}

export function parseSizeToken(token: string): number | null {
  const parsed = parseSizeTokenDetailed(token);
  return parsed && !parsed.geometric ? parsed.fraction : null;
}

/** Stored sentinels. The engine expands `e` / `2e` / `a` / `Nx` at the node. */
export const ALL_IN_SPEC = -1e9;
export const GEO_BASE = -2e9;
export const MULTIPLE_BASE = -3e9;
export const EXPLICIT_EMPTY_SPEC = -4e9;

export function isExplicitEmptyList(specs: number[]): boolean {
  return (
    specs.length === 1 &&
    specs[0] <= EXPLICIT_EMPTY_SPEC + 0.5 &&
    specs[0] > EXPLICIT_EMPTY_SPEC - 1e6
  );
}

export function isGeometricSpec(spec: number): boolean {
  return spec <= GEO_BASE + 0.5 && spec > MULTIPLE_BASE + 0.5;
}

export function isMultipleSpec(spec: number): boolean {
  return spec <= MULTIPLE_BASE + 0.5 && spec > EXPLICIT_EMPTY_SPEC + 0.5;
}

export function isAllInSpec(spec: number): boolean {
  return spec < -5e8 && spec > -1.5e9;
}

export function isExplicitEmptySpec(spec: number): boolean {
  return spec <= EXPLICIT_EMPTY_SPEC + 0.5 && spec > EXPLICIT_EMPTY_SPEC - 1e6;
}

function trimNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  const rounded = Math.round(value * 1e6) / 1e6;
  if (Math.abs(rounded - Math.round(rounded)) < 1e-6) {
    return String(Math.round(rounded));
  }
  return String(rounded);
}

/**
 * One stored spec back into a Build token (`50`, `0.5%`, `e`, `2e`, `20c`, `2.5x`, `a`).
 * Percentages that would not round-trip as a bare Pio number are written with `%`.
 */
export function formatEngineSpec(spec: number): string {
  if (isExplicitEmptySpec(spec)) {
    return "-";
  }
  if (isAllInSpec(spec)) {
    return "a";
  }
  if (isGeometricSpec(spec)) {
    const streets = Math.round(-(spec - GEO_BASE));
    return streets <= 0 ? "e" : `${streets}e`;
  }
  if (isMultipleSpec(spec)) {
    return `${trimNumber(-(spec - MULTIPLE_BASE))}x`;
  }
  if (spec < 0 && spec > -1e8) {
    return `${trimNumber(-spec)}c`;
  }
  const pct = spec * 100;
  const bare = trimNumber(pct);
  const parsed = parseSizeToken(bare);
  if (parsed == null || Math.abs(parsed - spec) > 1e-9) {
    return `${bare}%`;
  }
  return bare;
}

function finiteSpecs(values: unknown): number[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return values.map((value) => Number(value)).filter((value) => Number.isFinite(value));
}

function formatSpecList(specs: number[]): string {
  if (specs.length === 0 || isExplicitEmptyList(specs)) {
    return "";
  }
  return specs.map(formatEngineSpec).join(", ");
}

/**
 * Display a stored size list. An explicit-empty raise list is `-` (no raises).
 * Prefer {@link formatStreetBetField} / {@link formatStreetRaiseField} when
 * importing config so inheritance is resolved into editable text.
 */
export function formatStoredSizes(
  values: unknown,
  options?: { raise?: boolean; matchBets?: unknown },
): string {
  const specs = finiteSpecs(values);
  if (specs.length === 0) {
    return "";
  }
  if (isExplicitEmptyList(specs)) {
    return options?.raise ? "-" : "";
  }
  // matchBets is accepted for call-site compat but no longer blanks matching raises —
  // blank raise fields mean no raises, so import must show the real raise text.
  void options?.matchBets;
  return specs.map(formatEngineSpec).join(", ");
}

/** Resolve engine inherit (`[]`) against a shared list; leave explicit-empty as-is. */
export function resolveInheritedSpecs(
  streetValues: unknown,
  sharedValues: unknown,
): number[] {
  const street = finiteSpecs(streetValues);
  if (isExplicitEmptyList(street)) {
    return street;
  }
  if (street.length === 0) {
    return finiteSpecs(sharedValues);
  }
  return street;
}

/**
 * Format a per-street bet list for Build. Empty (`[]`, inherit shared) resolves
 * to the shared sizes so rebuild keeps the same tree. Explicit-empty → blank
 * (check-only).
 */
export function formatStreetBetField(
  streetValues: unknown,
  sharedValues: unknown,
): string {
  const resolved = resolveInheritedSpecs(streetValues, sharedValues);
  if (isExplicitEmptyList(resolved) || resolved.length === 0) {
    return "";
  }
  return formatSpecList(resolved);
}

/**
 * Format a per-street raise list for Build.
 * - Explicit-empty → `-`
 * - Empty (`[]`) resolves shared raises; if that is also empty → `-` (no raises)
 * - Otherwise the resolved size text (including when it matches street bets —
 *   blank encode means no raises, so matching bets must stay visible)
 */
export function formatStreetRaiseField(
  raiseValues: unknown,
  sharedRaises: unknown,
  _streetBets?: unknown,
  _options?: { sharedBets?: unknown },
): string {
  const raises = finiteSpecs(raiseValues);
  if (isExplicitEmptyList(raises)) {
    return "-";
  }
  const resolved = raises.length === 0 ? finiteSpecs(sharedRaises) : raises;
  if (resolved.length === 0 || isExplicitEmptyList(resolved)) {
    return "-";
  }
  return formatSpecList(resolved);
}

/**
 * Format a donk list for Build. Empty (use normal bets) materializes the street
 * (or shared) bet sizes as visible text — text is the sole authority. Explicit-empty
 * → blank (no lead). `copyBets` is always false; hidden donk checkboxes are ignored
 * when encoding blank fields.
 */
export function formatDonkField(
  donkValues: unknown,
  streetBets: unknown,
  sharedDonk?: unknown,
): { text: string; copyBets: boolean } {
  const donk = finiteSpecs(donkValues);
  if (isExplicitEmptyList(donk)) {
    return { text: "", copyBets: false };
  }
  if (donk.length > 0) {
    return { text: formatSpecList(donk), copyBets: false };
  }
  const shared = finiteSpecs(sharedDonk);
  if (shared.length > 0 && !isExplicitEmptyList(shared)) {
    return { text: formatSpecList(shared), copyBets: false };
  }
  // Engine empty donk → use normal bets. Materialize street bets as editable text.
  const bets = finiteSpecs(streetBets);
  if (bets.length === 0 || isExplicitEmptyList(bets)) {
    return { text: "", copyBets: false };
  }
  return { text: formatSpecList(bets), copyBets: false };
}

/** One rejected size token from {@link parseSizeListStrict}. */
export interface SizeListTokenError {
  token: string;
  message: string;
}

export type SizeListParseResult =
  | { ok: true; specs: number[] }
  | { ok: false; errors: SizeListTokenError[] };

export interface ParseSizeListOptions {
  /** When true, `2x` / `2.5x` raise multiples are accepted. */
  allowMultiple?: boolean;
}

/**
 * Strict comma-delimited size-list parser.
 *
 * Delimiter is comma only — spaces alone (`50 100`) are invalid. Unrecognized
 * tokens are errors (never skipped). Blank text and a lone `-` / `none` / `x`
 * yield the explicit-empty sentinel (check-only / no lead / no raises).
 */
export function parseSizeListStrict(
  text: string,
  options: ParseSizeListOptions = {},
): SizeListParseResult {
  const allowMultiple = Boolean(options.allowMultiple);
  const parts = text
    .split(/[,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return { ok: true, specs: [EXPLICIT_EMPTY_SPEC] };
  }
  if (
    parts.length === 1 &&
    (parts[0] === "-" ||
      parts[0].toLowerCase() === "none" ||
      parts[0].toLowerCase() === "x")
  ) {
    return { ok: true, specs: [EXPLICIT_EMPTY_SPEC] };
  }

  const specs: number[] = [];
  const errors: SizeListTokenError[] = [];

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "a" || lower === "allin" || lower === "all-in") {
      specs.push(ALL_IN_SPEC);
      continue;
    }

    const geo = lower.match(/^(\d+(?:\.\d+)?)?e$/);
    if (geo) {
      if (geo[1] === undefined) {
        specs.push(GEO_BASE);
        continue;
      }
      const streets = Number(geo[1]);
      if (!Number.isInteger(streets) || streets <= 0 || streets > 100) {
        errors.push({
          token: part,
          message: "geometric size must be e or Ne with integer N in 1–100",
        });
        continue;
      }
      specs.push(GEO_BASE - streets);
      continue;
    }

    const multiple = lower.match(/^(\d+(?:\.\d+)?)x$/);
    if (multiple) {
      if (!allowMultiple) {
        errors.push({
          token: part,
          message: "raise multiples (Nx) are only valid in raise fields",
        });
        continue;
      }
      const value = Number(multiple[1]);
      if (!Number.isFinite(value) || value <= 0) {
        errors.push({
          token: part,
          message: "raise multiple must be a positive number",
        });
        continue;
      }
      specs.push(MULTIPLE_BASE - value);
      continue;
    }

    const parsed = parseSizeTokenDetailed(part);
    if (!parsed || parsed.geometric || parsed.raiseMultiple) {
      errors.push({
        token: part,
        message: "unrecognized size token (use comma-separated pot %, e, a, Nc)",
      });
      continue;
    }
    specs.push(parsed.fraction);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  if (specs.length === 0) {
    return { ok: true, specs: [EXPLICIT_EMPTY_SPEC] };
  }
  return { ok: true, specs };
}

function formatSizeListErrors(errors: SizeListTokenError[]): string {
  return errors
    .map((entry) => `"${entry.token}": ${entry.message}`)
    .join("; ");
}

function requireSizeList(
  text: string,
  options: ParseSizeListOptions,
  label: string,
): number[] {
  const parsed = parseSizeListStrict(text, options);
  if (!parsed.ok) {
    throw new Error(`${label}: ${formatSizeListErrors(parsed.errors)}`);
  }
  return parsed.specs;
}

/** Blank bet text is an explicit-empty list (forced check). `e` / `a` stay sentinels. */
export function encodeBetList(text: string): number[] {
  return requireSizeList(text, { allowMultiple: false }, "bet sizes");
}

/**
 * Blank raise text is explicit-empty (no pot-fraction raises) — never copies
 * that street's bets. List sizes or `2.5x` explicitly. `-` / `none` / `x` is
 * the same explicit-empty sentinel. `betSpecs` is unused (kept for call-site
 * compatibility).
 */
export function encodeRaiseList(text: string, _betSpecs: number[] = []): number[] {
  if (!text.trim()) {
    return [EXPLICIT_EMPTY_SPEC];
  }
  return requireSizeList(text, { allowMultiple: true }, "raise sizes");
}

export interface BettingDraftInput {
  oopBets: string;
  ipBets: string;
  oopFlop: string;
  ipFlop: string;
  oopTurn: string;
  ipTurn: string;
  oopRiver: string;
  ipRiver: string;
  oopFlopRaises: string;
  ipFlopRaises: string;
  oopTurnRaises: string;
  ipTurnRaises: string;
  oopRiverRaises: string;
  ipRiverRaises: string;
  oopFlopDonk: string;
  oopTurnDonk: string;
  oopRiverDonk: string;
  /** Ignored when the matching donk text is blank (blank = no lead). */
  donkFlop?: boolean;
  donkTurn?: boolean;
  donkRiver?: boolean;
  mergeThresholdPct?: number;
}

/** Shared/legacy size fields that may also appear on a full {@link SpotDraft}. */
export interface BettingDraftFields extends BettingDraftInput {
  oopRaises?: string;
  ipRaises?: string;
  oopDonk?: string;
}

function encodeSharedBets(text: string): number[] {
  if (!text.trim()) {
    return [];
  }
  const specs = requireSizeList(text, { allowMultiple: false }, "shared bets");
  return isExplicitEmptyList(specs) ? [] : specs;
}

/**
 * Blank donk text is always explicit-empty (no lead), regardless of legacy
 * donk* checkbox flags. Nonblank text is parsed strictly as a bet list.
 */
function encodeDonk(text: string): number[] {
  if (!text.trim()) {
    return [EXPLICIT_EMPTY_SPEC];
  }
  return requireSizeList(text, { allowMultiple: false }, "donk sizes");
}

interface BettingFieldSpec {
  key: keyof BettingDraftFields;
  label: string;
  kind: "bet" | "raise" | "donk" | "sharedBet" | "sharedRaise" | "sharedDonk";
}

const BETTING_FIELD_SPECS: BettingFieldSpec[] = [
  { key: "oopBets", label: "OOP shared bets", kind: "sharedBet" },
  { key: "ipBets", label: "IP shared bets", kind: "sharedBet" },
  { key: "oopRaises", label: "OOP shared raises", kind: "sharedRaise" },
  { key: "ipRaises", label: "IP shared raises", kind: "sharedRaise" },
  { key: "oopFlop", label: "OOP flop bets", kind: "bet" },
  { key: "ipFlop", label: "IP flop bets", kind: "bet" },
  { key: "oopTurn", label: "OOP turn bets", kind: "bet" },
  { key: "ipTurn", label: "IP turn bets", kind: "bet" },
  { key: "oopRiver", label: "OOP river bets", kind: "bet" },
  { key: "ipRiver", label: "IP river bets", kind: "bet" },
  { key: "oopFlopRaises", label: "OOP flop raises", kind: "raise" },
  { key: "ipFlopRaises", label: "IP flop raises", kind: "raise" },
  { key: "oopTurnRaises", label: "OOP turn raises", kind: "raise" },
  { key: "ipTurnRaises", label: "IP turn raises", kind: "raise" },
  { key: "oopRiverRaises", label: "OOP river raises", kind: "raise" },
  { key: "ipRiverRaises", label: "IP river raises", kind: "raise" },
  { key: "oopDonk", label: "OOP shared donk", kind: "sharedDonk" },
  { key: "oopFlopDonk", label: "OOP flop donk", kind: "donk" },
  { key: "oopTurnDonk", label: "OOP turn donk", kind: "donk" },
  { key: "oopRiverDonk", label: "OOP river donk", kind: "donk" },
];

/**
 * Validate every betting-list field with {@link parseSizeListStrict}.
 * Blank raise (no raises), blank shared bets (inherit), and blank donk (no lead)
 * are intentional and skip parsing.
 */
export function validateBettingLists(draft: BettingDraftFields): string[] {
  const errors: string[] = [];
  for (const field of BETTING_FIELD_SPECS) {
    const raw = draft[field.key];
    if (typeof raw !== "string") {
      continue;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      // Blank raise → no raises; blank shared bets → inherit; blank donk → no lead.
      continue;
    }
    const allowMultiple =
      field.kind === "raise" || field.kind === "sharedRaise";
    const parsed = parseSizeListStrict(raw, { allowMultiple });
    if (!parsed.ok) {
      for (const entry of parsed.errors) {
        errors.push(`${field.label}: "${entry.token}" — ${entry.message}`);
      }
    }
  }
  return errors;
}

/**
 * Size fields for a solve or tree-preview job.
 * Geometric and all-in are per-list tokens (`e`, `a`). Study callers send
 * `allow_all_in: 0` — list `a` explicitly; the engine's `force_all_in` path
 * still offers that token when the auto all-in switch is off.
 * Invalid tokens throw — validate with {@link validateBettingLists} first.
 */
export function encodeBettingJob(draft: BettingDraftInput) {
  const oopFlop = encodeBetList(draft.oopFlop);
  const ipFlop = encodeBetList(draft.ipFlop);
  const oopTurn = encodeBetList(draft.oopTurn);
  const ipTurn = encodeBetList(draft.ipTurn);
  const oopRiver = encodeBetList(draft.oopRiver);
  const ipRiver = encodeBetList(draft.ipRiver);
  const threshold = draft.mergeThresholdPct ?? 0;
  return {
    oop_bets: encodeSharedBets(draft.oopBets),
    ip_bets: encodeSharedBets(draft.ipBets),
    oop_raises: [] as number[],
    ip_raises: [] as number[],
    oop_raise_multiples: [] as number[],
    ip_raise_multiples: [] as number[],
    oop_flop_bets: oopFlop,
    ip_flop_bets: ipFlop,
    oop_turn_bets: oopTurn,
    ip_turn_bets: ipTurn,
    oop_river_bets: oopRiver,
    ip_river_bets: ipRiver,
    oop_flop_raises: encodeRaiseList(draft.oopFlopRaises, oopFlop),
    ip_flop_raises: encodeRaiseList(draft.ipFlopRaises, ipFlop),
    oop_turn_raises: encodeRaiseList(draft.oopTurnRaises, oopTurn),
    ip_turn_raises: encodeRaiseList(draft.ipTurnRaises, ipTurn),
    oop_river_raises: encodeRaiseList(draft.oopRiverRaises, oopRiver),
    ip_river_raises: encodeRaiseList(draft.ipRiverRaises, ipRiver),
    oop_donk: [] as number[],
    // donk* booleans are ignored: blank text is always no lead.
    oop_flop_donk: encodeDonk(draft.oopFlopDonk),
    oop_turn_donk: encodeDonk(draft.oopTurnDonk),
    oop_river_donk: encodeDonk(draft.oopRiverDonk),
    merge_threshold: threshold > 0 ? threshold / 100 : 0,
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

/** Parsed chip-sized engine action (`Bet 50`, `Raise to 400`, `Bet 150 all-in`). */
export interface SizedActionParse {
  /** bet / raise / donk / call — call has chips but no pot tag. */
  kind: "bet" | "raise" | "donk" | "call";
  /**
   * Chip amount from the label: bet/donk/call size, or raise-to street total
   * (or legacy `Raise N` size when not `Raise to`).
   */
  chips: number;
  /** True when the engine label used the `Raise to N` form. */
  raiseTo: boolean;
  /** True when the label ends with `all-in`. */
  allIn: boolean;
}

/**
 * Parse an engine decision label into kind + chips.
 * Accepts trailing ` all-in` (engine `chip_label`) and both `Raise to N`
 * (production) and legacy `Raise N` forms.
 */
export function parseSizedAction(label: string): SizedActionParse | null {
  const trimmed = label.trim();
  if (!trimmed) {
    return null;
  }
  const allIn = /\s+all-?in$/i.test(trimmed);
  const core = allIn
    ? trimmed.replace(/\s+all-?in$/i, "").trim()
    : trimmed;

  const raiseTo = core.match(/^Raise\s+to\s+(-?\d+(?:\.\d+)?)$/i);
  if (raiseTo) {
    const chips = Number(raiseTo[1]);
    if (!Number.isFinite(chips)) {
      return null;
    }
    return { kind: "raise", chips, raiseTo: true, allIn };
  }

  const raise = core.match(/^Raise\s+(-?\d+(?:\.\d+)?)$/i);
  if (raise) {
    const chips = Number(raise[1]);
    if (!Number.isFinite(chips)) {
      return null;
    }
    return { kind: "raise", chips, raiseTo: false, allIn };
  }

  const betDonk = core.match(/^(Bet|Donk)\s+(-?\d+(?:\.\d+)?)$/i);
  if (betDonk) {
    const chips = Number(betDonk[2]);
    if (!Number.isFinite(chips)) {
      return null;
    }
    const kind = betDonk[1]!.toLowerCase().startsWith("d") ? "donk" : "bet";
    return { kind, chips, raiseTo: false, allIn };
  }

  const call = core.match(/^Call\s+(-?\d+(?:\.\d+)?)$/i);
  if (call) {
    const chips = Number(call[1]);
    if (!Number.isFinite(chips)) {
      return null;
    }
    return { kind: "call", chips, raiseTo: false, allIn };
  }

  return null;
}

/**
 * Chip amount used for pot-% tags.
 * Bets/donks use the labeled size. `Raise to N` uses the raise increment
 * (`N - to_call`) when facing a bet — engine sizes against pot+call
 * ({@link actionSizePotBasis}). Legacy `Raise N` keeps N as the size.
 */
export function sizeChipsForPotTag(
  parsed: SizedActionParse,
  toCall = 0,
): number {
  if (parsed.kind === "raise" && parsed.raiseTo) {
    return Math.max(0, Math.abs(parsed.chips) - Math.max(0, toCall));
  }
  return Math.abs(parsed.chips);
}

/**
 * How to render a sized all-in on a pot tag.
 * - `base`: `b150` / `r100` (no all-in marker)
 * - `display`: visible action tags — `b150 Allin` / `r100 Allin`
 * - `line`: abbreviated line notation — `b150(a)` / `r100(a)`
 */
export type PotTagVariant = "base" | "display" | "line";

/** Append the shared all-in marker for display tags or line notation. */
export function withAllInPotTagSuffix(
  baseTag: string,
  allIn: boolean,
  variant: PotTagVariant = "base",
): string {
  if (!allIn || variant === "base") {
    return baseTag;
  }
  if (variant === "display") {
    return `${baseTag} Allin`;
  }
  return `${baseTag}(a)`;
}

/**
 * Compact pot tag like `b75` / `r150` from an engine action label + pot.
 * Sized all-ins reuse {@link parseSizedAction}.allIn so display tags and
 * line notation stay on one path (`Allin` vs `(a)`).
 */
export function potTagFromLabel(
  label: string,
  pot: number,
  toCall = 0,
  variant: PotTagVariant = "base",
): string | null {
  if (!(pot > 0)) {
    return null;
  }
  const parsed = parseSizedAction(label);
  if (!parsed || parsed.kind === "call") {
    return null;
  }
  const sizeChips = sizeChipsForPotTag(parsed, toCall);
  if (!(sizeChips > 0) && parsed.kind === "raise" && parsed.raiseTo) {
    // Raise-to equal to call only — still show r0 rather than dropping the tag.
  }
  const pct = Math.round((sizeChips / pot) * 100);
  const kind = parsed.kind === "raise" ? "r" : "b";
  return withAllInPotTagSuffix(`${kind}${pct}`, parsed.allIn, variant);
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
  const parsed = parseSizedAction(label);
  return parsed ? parsed.chips : null;
}

export interface ActionDisplayParts {
  /** Compact pot tag (`b50` / `b150 Allin`) or passive label (`Check`). Never a bare percent. */
  primary: string;
  /** Optional chips with units (`50.0 chips`), or null. */
  secondary: string | null;
  /** Engine/raw label for tooltips and a11y. */
  raw: string;
  /** Compact pot tag when applicable (`b50` / `b150 Allin`), else null. */
  potTag: string | null;
}

export interface FormatActionDisplayOptions {
  /** Facing amount at the decision node; required for accurate `Raise to` tags. */
  toCall?: number;
}

/**
 * Display label for Study action blocks.
 *
 * Hard policy: a 50% pot bet stays primary `b50` (not `Bet 50%`). Frequency is
 * rendered separately via `formatFrequencyPct`. Absolute chips are optional
 * secondary/tooltip text with an explicit `chips` unit.
 *
 * Engine labels may be `Bet N`, `Raise to N`, and optional trailing ` all-in`.
 */
export function formatActionDisplay(
  label: string,
  pot: number,
  mode: BetSizeDisplayMode = "both",
  options: FormatActionDisplayOptions = {},
): ActionDisplayParts {
  const trimmed = label.trim();
  const toCall = Number(options.toCall ?? 0);
  // Visible tags use the display variant (`b150 Allin`); line notation uses
  // `line` via {@link potTagFromLabel} / abbreviatePathAction.
  const potTag = potTagFromLabel(trimmed, pot, toCall, "display");
  if (/^(check|fold|call)$/i.test(trimmed) || /^call\b/i.test(trimmed)) {
    return { primary: trimmed, secondary: null, raw: trimmed, potTag: null };
  }
  // Bare all-in (no size) — keep raw. Sized `Bet N all-in` continues below so
  // pot tags still appear (do not treat "all-in" as a reason to skip tags).
  if (/^all[\s-]*in$/i.test(trimmed)) {
    return { primary: trimmed, secondary: null, raw: trimmed, potTag: null };
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
  options: FormatActionDisplayOptions = {},
): string {
  const display = formatActionDisplay(label, pot, mode, options);
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
