import type { SpotDraft } from "../types";

export type SetupMode = "create" | "edit" | "duplicate";

export type SetupFieldProvenance =
  | "explicit_request"
  | "selected_profile"
  | "saved_preference"
  | "default"
  | "derived"
  | "model_generated"
  | "interpolated"
  | "seat_action_composed"
  | "unresolved";

export type PreflopActionKind =
  | "fold"
  | "call"
  | "check"
  | "open"
  | "raise"
  | "bet"
  | "all_in";

export interface PreflopAction {
  seat: string;
  action: PreflopActionKind;
  sizeBb?: number;
}

export interface StudySetupTreePreset {
  oopBets?: string;
  ipBets?: string;
  oopFlop?: string;
  ipFlop?: string;
  oopTurn?: string;
  ipTurn?: string;
  oopRiver?: string;
  ipRiver?: string;
  oopDonk?: string;
  potCap?: number;
  noThreeBet?: boolean;
  geometric?: boolean;
  maxRaises?: number;
}

/**
 * Preflop pot type / action family. Required for create when matching ranges;
 * never guess SRP vs 3BP vs 4BP from positions alone.
 */
export type PotType = "SRP" | "3BP" | "4BP";

/** Structured intent extracted from natural language (model proposal). */
export interface StudySetupIntent {
  mode: SetupMode;
  /** Postflop OOP position label, e.g. "BB". */
  oopPosition?: string;
  /** Postflop IP position label, e.g. "CO". */
  ipPosition?: string;
  /**
   * Rake / stakes-environment label such as "100NL".
   * Identifies a rake structure, not a personal player profile and never stack depth.
   */
  stakesLabel?: string;
  /** Preflop pot type (SRP / 3BP / 4BP). Required for create; do not invent. */
  potType?: PotType;
  /**
   * Starting stack in bb. When omitted on create, application code assumes
   * 100bb — never inferred from an NL / rake label.
   */
  stackBb?: number;
  openSizeBb?: number;
  board?: string;
  treePreset?: StudySetupTreePreset;
  /** Catalogue id or display-name query for a standard/GTO range entry. */
  profileQuery?: string;
  preflopActions?: PreflopAction[];
  needsClarification?: string[];
  unsupported?: string[];
}

export type SetupDraftFields = Partial<SpotDraft> & {
  oopRange?: string;
  ipRange?: string;
};

/**
 * Application-facing patch. Field values may arrive from several sources;
 * `explicitFields` / `profileFields` drive conflict detection during merge.
 * Stakes labels belong on intent/explicit metadata — they must not set `stack`.
 */
export interface SetupPatch extends SetupDraftFields {
  mode?: SetupMode;
  profileId?: string | null;
  profileRevision?: number | null;
  profile?: SetupProfileRef | null;
  provenance?: Record<string, SetupFieldProvenance>;
  /** Values supplied by an explicitly selected profile (conflict source). */
  profileFields?: SetupDraftFields & {
    stackBb?: number;
    openSizeBb?: number;
  };
  /** Values the player explicitly requested (wins over profile; conflicts if disagree). */
  explicitFields?: SetupDraftFields & {
    stackBb?: number;
    openSizeBb?: number;
    stakesLabel?: string;
  };
  /** Pot/stack derived in application code from preflop history. */
  derived?: {
    potBb?: number;
    stackBb?: number;
  };
  requestRevision?: number;
}

export interface SetupProfileRef {
  id: string;
  revision: number;
  displayName: string;
  classification: string;
}

export interface SetupConflict {
  field: string;
  message: string;
  options?: string[];
}

export interface SetupMissing {
  field: string;
  message: string;
  reason: string;
}

export interface SetupDraftResult {
  ok: boolean;
  draftPatch: Partial<SpotDraft> & { oopRange?: string; ipRange?: string };
  pot?: number;
  stack?: number;
  provenance: Record<string, SetupFieldProvenance>;
  conflicts: SetupConflict[];
  missing: SetupMissing[];
  summary: string[];
  /** False when board missing, conflicts present, or required fields unresolved. */
  canSolve: boolean;
  profile?: SetupProfileRef | null;
  requestRevision: number;
}

export interface SetupValidationResult {
  ok: boolean;
  errors: string[];
}
