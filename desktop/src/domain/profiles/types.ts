/** Versioned range-profile catalogue types (Stage B). */

export const RANGE_PROFILE_SCHEMA_VERSION = 1;

export type GameFormat = "cash_6max" | "cash_9max" | "unknown" | (string & {});

export type PreflopActionKind = "open" | "call" | "fold" | "raise" | "check";

export interface PreflopAction {
  /** Seat / position label, e.g. "CO", "BB", "SB". */
  position: string;
  kind: PreflopActionKind;
  /** Size in big blinds when applicable (open/raise/call amount into pot). */
  sizeBb?: number;
}

export interface ProfilePositions {
  oop: string;
  ip: string;
}

export interface ProfileBlinds {
  sb: number;
  bb: number;
}

export interface ProfileRake {
  rate: number;
  cap: number;
  /** How rake is collected, e.g. "pot" | "dealt" | "unknown". */
  collection: string;
  /** When false, rate/cap/collection must not be treated as verified. */
  known: boolean;
}

export interface ProfileLabels {
  /**
   * Rake / stakes-environment key such as "100NL".
   * Not a personal player-profile name; used with pot type, positions, and stacks
   * to select standard/GTO catalogue ranges for that rake structure.
   */
  stakes?: string;
  site?: string;
  pool?: string;
  intendedUse?: string;
}

export type ProfileClassification =
  | "equilibrium_model"
  | "population_estimate"
  | "personal_adjustment"
  | "synthetic_fixture"
  | "model_generated"
  | "interpolated"
  | "unknown";

export interface ProfileProvenance {
  source: string;
  classification: ProfileClassification;
  notes?: string;
}

export interface ProfileRanges {
  /** Weighted combo text for the existing `parseRangeText` parser. */
  oop: string;
  ip: string;
}

/**
 * Versioned paired-range profile. Ranges share game assumptions and action history.
 * Incomplete / legacy wrappers set `legacyPreset` and must not claim exact matches.
 */
export interface RangeProfile {
  schemaVersion: number;
  /** Stable catalogue id. */
  id: string;
  /** Bumps when range weights or strategic assumptions change. */
  dataRevision: string | number;
  displayName: string;
  format: GameFormat;
  playerCount: number;
  positions: ProfilePositions;
  /** Ordered preflop history with sizes in bb. */
  preflopActions: PreflopAction[];
  startingStackBb: number;
  blinds: ProfileBlinds;
  antes?: number;
  rake: ProfileRake;
  labels?: ProfileLabels;
  ranges: ProfileRanges;
  provenance: ProfileProvenance;
  /**
   * Incomplete metadata (e.g. wrapped flat `.txt` preset).
   * Assumptions unknown; excluded from automatic exact-match claims.
   */
  legacyPreset?: boolean;
}

/** Fields the matcher compares against the catalogue. */
export interface RangeProfileQuery {
  positions?: Partial<ProfilePositions>;
  /** Ordered action history; open size is taken from the first `open` when present. */
  preflopActions?: PreflopAction[];
  /** Convenience: open size in bb (also derived from preflopActions). */
  openSizeBb?: number;
  /**
   * Starting stack in bb. When the player is silent on stacks, callers should
   * pass 100 (default) rather than omitting — never invent from an NL label.
   */
  stackBb?: number;
  format?: GameFormat;
  /**
   * Rake / stakes-environment label (e.g. "100NL"). Soft filter with other
   * strategic keys; never sufficient alone and never a personal profile id.
   */
  stakesLabel?: string;
  /** Prefop pot family; when set, must agree with catalogue action history. */
  potType?: "SRP" | "3BP" | "4BP";
  rake?: Partial<ProfileRake>;
}

export interface MatchAlternative {
  profile: RangeProfile;
  /** Human-readable difference labels, e.g. "different open size". */
  differences: string[];
}

export interface MatchResult {
  exact: RangeProfile[];
  alternatives: MatchAlternative[];
  /** Present when both exact and alternatives are empty. */
  none?: string;
}

/**
 * Snapshot stored with a study when a profile is applied.
 * Reopen must use these range strings + revision, not a newer live catalogue entry.
 */
export interface AppliedProfileSnapshot {
  profileId: string;
  dataRevision: string | number;
  ranges: ProfileRanges;
}

export interface LegacyPresetInput {
  id: string;
  name: string;
  text: string;
  /** Optional seat target when wrapping a single-player preset. Defaults to both seats. */
  seat?: "oop" | "ip" | "both";
}

export const RANGE_PROFILES_STORAGE_KEY = "holdem-study-range-profiles";
