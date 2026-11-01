/** Seat×action range atoms — preferred catalogue grain over OOP/IP pair packs. */

export const SEAT_ACTION_SCHEMA_VERSION = 1;

export type SeatActionKind =
  | "open"
  | "call"
  | "three_bet"
  | "four_bet"
  | "four_bet_call"
  | "five_bet"
  | "jam"
  | "fold"
  | "unknown";

/**
 * One position's weighted range for a specific action vs a prior action.
 * Example: BB call vs CO open; CO open (vsAction omitted / "none").
 */
export interface SeatActionRange {
  schemaVersion: number;
  id: string;
  dataRevision: string | number;
  displayName: string;
  /** Hero seat holding this range, e.g. BB, CO, BTN. */
  heroPosition: string;
  /** Villain seat when the action is vs someone, e.g. CO. */
  villainPosition?: string;
  /** What hero is doing with this range. */
  action: SeatActionKind;
  /**
   * Prior villain (or line) action this faces.
   * Opens use "none". Call vs open → "open". Call vs 4bet → "four_bet".
   */
  vsAction: SeatActionKind | "none";
  /** Weighted combo text for `parseRangeText`. */
  range: string;
  format?: string;
  startingStackBb?: number;
  openSizeBb?: number;
  labels?: {
    stakes?: string;
    site?: string;
    pool?: string;
    intendedUse?: string;
  };
  provenance: {
    source: string;
    classification:
      | "equilibrium_model"
      | "population_estimate"
      | "personal_adjustment"
      | "synthetic_fixture"
      | "model_generated"
      | "interpolated"
      | "unknown";
    notes?: string;
  };
}

export interface SeatActionQuery {
  heroPosition?: string;
  villainPosition?: string;
  action?: SeatActionKind;
  vsAction?: SeatActionKind | "none";
  stakesLabel?: string;
  stackBb?: number;
}

export const SEAT_ACTION_STORAGE_KEY = "holdem-study-seat-action-ranges";
