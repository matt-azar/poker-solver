import { boardCards, parseCard } from "../range";
import { DEFAULT_SPOT, type SpotDraft } from "../types";
import type { StudySetupPreferences } from "./preferences";
import {
  assertRevision,
  isStaleProposal,
} from "./revision";
import type {
  SetupConflict,
  SetupDraftResult,
  SetupFieldProvenance,
  SetupMissing,
  SetupMode,
  SetupPatch,
  SetupValidationResult,
} from "./types";

export { assertRevision, isStaleProposal };

const TREE_KEYS = [
  "oopBets",
  "ipBets",
  "oopFlop",
  "ipFlop",
  "oopTurn",
  "ipTurn",
  "oopRiver",
  "ipRiver",
  "oopDonk",
] as const;

type DraftKey = keyof SpotDraft;

function cloneSpot(spot: SpotDraft): SpotDraft {
  return { ...spot };
}

/**
 * Build a starting draft for create / duplicate.
 * Create clears board and ranges so prior study state is not inherited.
 * Duplicate keeps board and ranges from the source (caller passes them via `source`).
 * Ranges stay empty until a profile (or explicit patch) supplies them.
 */
export function createBlankSetupDraft(
  mode: SetupMode,
  source: SpotDraft = DEFAULT_SPOT,
): SpotDraft {
  const base = cloneSpot(DEFAULT_SPOT);
  if (mode === "edit") {
    return cloneSpot(source);
  }
  if (mode === "duplicate") {
    return {
      ...cloneSpot(source),
      solutionPath: "",
    };
  }
  // create — deliberate resets of board/ranges unrelated to a new study
  return {
    ...base,
    boardText: "",
    oopRange: "",
    ipRange: "",
    pot: source.pot > 0 ? source.pot : base.pot,
    stack: source.stack > 0 ? source.stack : base.stack,
    solutionPath: "",
  };
}

function conflict(
  field: string,
  message: string,
  options?: string[],
): SetupConflict {
  return options ? { field, message, options } : { field, message };
}

function missing(field: string, message: string, reason: string): SetupMissing {
  return { field, message, reason };
}

function valuesDisagree(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) {
    return false;
  }
  if (typeof left === "number" && typeof right === "number") {
    return Math.abs(left - right) > 1e-9;
  }
  return String(left) !== String(right);
}

function applyPrefs(
  draft: Partial<SpotDraft>,
  provenance: Record<string, SetupFieldProvenance>,
  prefs?: StudySetupPreferences,
): void {
  if (!prefs) {
    return;
  }
  if (
    prefs.defaultStackBb !== undefined &&
    draft.stack === undefined &&
    provenance.stack === undefined
  ) {
    draft.stack = prefs.defaultStackBb;
    provenance.stack = "saved_preference";
  }
  if (prefs.defaultTreeBets) {
    for (const key of TREE_KEYS) {
      const value = prefs.defaultTreeBets[key];
      if (value !== undefined && draft[key] === undefined && provenance[key] === undefined) {
        draft[key] = value;
        provenance[key] = "saved_preference";
      }
    }
  }
  if (
    prefs.defaultPotCap !== undefined &&
    draft.potCap === undefined &&
    provenance.potCap === undefined
  ) {
    draft.potCap = prefs.defaultPotCap;
    provenance.potCap = "saved_preference";
  }
  if (
    prefs.defaultMaxRaises !== undefined &&
    draft.maxRaises === undefined &&
    provenance.maxRaises === undefined
  ) {
    draft.maxRaises = prefs.defaultMaxRaises;
    provenance.maxRaises = "saved_preference";
  }
  if (
    prefs.defaultAllowAllIn !== undefined &&
    draft.allowAllIn === undefined &&
    provenance.allowAllIn === undefined
  ) {
    draft.allowAllIn = prefs.defaultAllowAllIn;
    provenance.allowAllIn = "saved_preference";
  }
  if (
    prefs.defaultNoThreeBet !== undefined &&
    draft.noThreeBet === undefined &&
    provenance.noThreeBet === undefined
  ) {
    draft.noThreeBet = prefs.defaultNoThreeBet;
    provenance.noThreeBet = "saved_preference";
  }
  if (
    prefs.defaultGeometric !== undefined &&
    draft.geometric === undefined &&
    provenance.geometric === undefined
  ) {
    draft.geometric = prefs.defaultGeometric;
    provenance.geometric = "saved_preference";
  }
}

function collectConflicts(patch: SetupPatch): SetupConflict[] {
  const conflicts: SetupConflict[] = [];
  const explicit = patch.explicitFields ?? {};
  const profile = patch.profileFields ?? {};

  // Stakes labels must never silently become stack depths.
  if (explicit.stakesLabel && explicit.stackBb === undefined && profile.stackBb === undefined) {
    // Not a conflict — just ensure we do not invent stack from stakes.
  }

  const numericPairs: Array<{
    field: string;
    explicitValue: number | undefined;
    profileValue: number | undefined;
  }> = [
    {
      field: "stack",
      explicitValue: explicit.stackBb ?? explicit.stack,
      profileValue: profile.stackBb ?? profile.stack,
    },
    {
      field: "openSizeBb",
      explicitValue: explicit.openSizeBb,
      profileValue: profile.openSizeBb,
    },
    {
      field: "pot",
      explicitValue: explicit.pot,
      profileValue: profile.pot,
    },
  ];

  for (const pair of numericPairs) {
    if (
      pair.explicitValue !== undefined &&
      pair.profileValue !== undefined &&
      valuesDisagree(pair.explicitValue, pair.profileValue)
    ) {
      conflicts.push(
        conflict(
          pair.field,
          `Explicit ${pair.field} (${pair.explicitValue}) conflicts with profile (${pair.profileValue})`,
          [String(pair.explicitValue), String(pair.profileValue)],
        ),
      );
    }
  }

  for (const field of ["oopRange", "ipRange", "boardText", "oopBets", "ipBets"] as const) {
    const left = explicit[field];
    const right = profile[field];
    if (left !== undefined && right !== undefined && valuesDisagree(left, right)) {
      conflicts.push(
        conflict(
          field,
          `Explicit ${field} conflicts with selected profile`,
          [String(left), String(right)],
        ),
      );
    }
  }

  return conflicts;
}

function assignFromSource(
  target: Partial<SpotDraft> & { oopRange?: string; ipRange?: string },
  provenance: Record<string, SetupFieldProvenance>,
  source: Partial<SpotDraft> & {
    oopRange?: string;
    ipRange?: string;
    stackBb?: number;
    openSizeBb?: number;
    stakesLabel?: string;
  },
  tag: SetupFieldProvenance,
  skip: Set<string>,
): void {
  const stackValue =
    source.stackBb !== undefined ? source.stackBb : source.stack;
  if (stackValue !== undefined && !skip.has("stack") && target.stack === undefined) {
    // Never treat stakesLabel as stack — only stackBb / stack.
    target.stack = stackValue;
    provenance.stack = tag;
  }

  for (const [key, value] of Object.entries(source)) {
    if (
      key === "stackBb" ||
      key === "openSizeBb" ||
      key === "stakesLabel" ||
      key === "stack"
    ) {
      continue;
    }
    if (value === undefined || skip.has(key)) {
      continue;
    }
    if ((target as Record<string, unknown>)[key] !== undefined) {
      continue;
    }
    (target as Record<string, unknown>)[key] = value;
    provenance[key] = tag;
  }
}

/**
 * Merge a setup patch onto the current draft.
 * Resolve order: explicit request > selected profile > saved prefs > defaults.
 * Explicit vs profile disagreements become conflicts (no silent override).
 */
export function mergeSetupPatch(
  base: SpotDraft,
  patch: SetupPatch,
  prefs?: StudySetupPreferences,
): SetupDraftResult {
  const mode = patch.mode ?? "edit";
  const provenance: Record<string, SetupFieldProvenance> = {
    ...(patch.provenance ?? {}),
  };
  const summary: string[] = [];
  const conflicts = collectConflicts(patch);
  const conflictedFields = new Set(conflicts.map((item) => item.field));

  const draftPatch: Partial<SpotDraft> & { oopRange?: string; ipRange?: string } =
    {};

  // 1. Explicit request fields win.
  if (patch.explicitFields) {
    assignFromSource(
      draftPatch,
      provenance,
      patch.explicitFields,
      "explicit_request",
      conflictedFields,
    );
    if (patch.explicitFields.stakesLabel) {
      const label = patch.explicitFields.stakesLabel;
      const isCev = /^cev$/i.test(label.trim());
      summary.push(
        isCev
          ? "Rake environment cEV (chip EV / no rake); does not set stack"
          : `Rake/stakes environment ${label} recorded; does not set stack`,
      );
      provenance.stakesLabel = "explicit_request";
    }
  }

  // Top-level patch fields marked explicit via provenance, or treated as explicit
  // when listed without a separate explicitFields bag.
  const topLevelKeys = Object.keys(patch).filter((key) => {
    return ![
      "mode",
      "profileId",
      "profileRevision",
      "profile",
      "provenance",
      "profileFields",
      "explicitFields",
      "derived",
      "requestRevision",
    ].includes(key);
  }) as DraftKey[];

  for (const key of topLevelKeys) {
    const value = patch[key];
    if (value === undefined || conflictedFields.has(key)) {
      continue;
    }
    const tag = provenance[key] ?? "explicit_request";
    if (draftPatch[key] === undefined) {
      (draftPatch as Record<string, unknown>)[key] = value;
      provenance[key] = tag;
    }
  }

  // 2. Profile fields (skipped when conflicting with explicit).
  if (patch.profileFields) {
    assignFromSource(
      draftPatch,
      provenance,
      patch.profileFields,
      "selected_profile",
      conflictedFields,
    );
  }

  // 3. Derived pot/stack from preflop history.
  if (patch.derived) {
    if (
      patch.derived.potBb !== undefined &&
      draftPatch.pot === undefined &&
      !conflictedFields.has("pot")
    ) {
      draftPatch.pot = patch.derived.potBb;
      provenance.pot = "derived";
      summary.push(`Derived pot ${patch.derived.potBb}bb from preflop history`);
    }
    if (
      patch.derived.stackBb !== undefined &&
      draftPatch.stack === undefined &&
      !conflictedFields.has("stack")
    ) {
      draftPatch.stack = patch.derived.stackBb;
      provenance.stack = "derived";
      summary.push(
        `Derived remaining stack ${patch.derived.stackBb}bb from preflop history`,
      );
    }
  }

  // 4. Saved preferences fill remaining gaps (never across an unresolved conflict).
  if (!conflictedFields.has("stack") && !conflictedFields.has("pot")) {
    applyPrefs(draftPatch, provenance, prefs);
  } else if (prefs) {
    const safePrefs = { ...prefs };
    if (conflictedFields.has("stack")) {
      delete safePrefs.defaultStackBb;
    }
    applyPrefs(draftPatch, provenance, safePrefs);
  }

  // 5. Visible defaults from base / DEFAULT_SPOT for create blanks only when still unset.
  // For edit mode, unspecified fields stay on the live base (not copied into the patch).
  // Conflicted fields stay unresolved so the UI can ask — never silently default them.
  if (mode === "create") {
    if (draftPatch.pot === undefined && !conflictedFields.has("pot")) {
      draftPatch.pot = DEFAULT_SPOT.pot;
      provenance.pot = provenance.pot ?? "default";
    }
    if (draftPatch.stack === undefined && !conflictedFields.has("stack")) {
      draftPatch.stack = DEFAULT_SPOT.stack;
      provenance.stack = provenance.stack ?? "default";
    }
    for (const key of TREE_KEYS) {
      if (draftPatch[key] === undefined && !conflictedFields.has(key)) {
        draftPatch[key] = DEFAULT_SPOT[key];
        provenance[key] = provenance[key] ?? "default";
      }
    }
  }

  for (const field of conflictedFields) {
    provenance[field] = "unresolved";
  }

  const mergedBoard =
    draftPatch.boardText !== undefined ? draftPatch.boardText : base.boardText;
  const mergedOop =
    draftPatch.oopRange !== undefined ? draftPatch.oopRange : base.oopRange;
  const mergedIp =
    draftPatch.ipRange !== undefined ? draftPatch.ipRange : base.ipRange;
  const mergedPot = draftPatch.pot !== undefined ? draftPatch.pot : base.pot;
  const mergedStack =
    draftPatch.stack !== undefined ? draftPatch.stack : base.stack;

  const missingFields: SetupMissing[] = [];
  const boardLen = boardCards(mergedBoard).length;
  if (!mergedBoard.trim() || boardLen < 3) {
    missingFields.push(
      missing(
        "board",
        "Select a flop, turn, or river board before solving",
        "board_missing",
      ),
    );
    provenance.boardText = provenance.boardText ?? "unresolved";
  }

  if (conflictedFields.has("stack") || draftPatch.stack === undefined) {
    if (
      conflictedFields.has("stack") ||
      (mergedStack <= 0 && provenance.stack === "unresolved")
    ) {
      // stack conflict already recorded
    }
  }

  for (const item of conflicts) {
    summary.push(`Conflict on ${item.field}: ${item.message}`);
  }
  for (const item of missingFields) {
    summary.push(`Missing ${item.field}: ${item.message}`);
  }

  if (patch.profile) {
    summary.push(
      `Profile ${patch.profile.displayName} (${patch.profile.id}@${patch.profile.revision})`,
    );
  } else if (patch.profileId) {
    summary.push(`Profile id ${patch.profileId}`);
  }

  const hasConflicts = conflicts.length > 0;
  const hasBlockingMissing = missingFields.some(
    (item) => item.reason === "board_missing",
  );
  const requiredUnresolved = Object.entries(provenance).some(
    ([, tag]) => tag === "unresolved",
  );

  const canSolve =
    !hasConflicts &&
    !hasBlockingMissing &&
    !requiredUnresolved &&
    boardLen >= 3 &&
    boardLen <= 5 &&
    mergedOop.trim().length > 0 &&
    mergedIp.trim().length > 0 &&
    mergedPot > 0 &&
    mergedStack > 0;

  const ok = !hasConflicts && missingFields.length === 0;

  return {
    ok,
    draftPatch,
    pot: draftPatch.pot,
    stack: draftPatch.stack,
    provenance,
    conflicts,
    missing: missingFields,
    summary,
    canSolve,
    profile: patch.profile ?? (patch.profileId
      ? {
          id: patch.profileId,
          revision: patch.profileRevision ?? 0,
          displayName: patch.profileId,
          classification: "unknown",
        }
      : null),
    requestRevision: patch.requestRevision ?? 0,
  };
}

/**
 * Soft client checks mirroring what Build needs before launching a solve.
 * Engine remains authoritative; this only blocks obviously incomplete drafts.
 */
export function validateSetupForSolve(draft: SpotDraft): SetupValidationResult {
  const errors: string[] = [];
  const cards = boardCards(draft.boardText);
  if (cards.length < 3 || cards.length > 5) {
    errors.push("Board must have 3–5 cards");
  }
  const seen = new Set<string>();
  for (const raw of cards) {
    const card = parseCard(raw);
    if (!card) {
      errors.push(`Invalid board card: ${raw}`);
      continue;
    }
    if (seen.has(card)) {
      errors.push(`Duplicate board card: ${card}`);
    }
    seen.add(card);
  }
  if (!draft.oopRange.trim()) {
    errors.push("OOP range is empty");
  }
  if (!draft.ipRange.trim()) {
    errors.push("IP range is empty");
  }
  if (!(draft.pot > 0)) {
    errors.push("Pot must be greater than 0");
  }
  if (!(draft.stack > 0)) {
    errors.push("Stack must be greater than 0");
  }
  if (!(draft.iterations > 0)) {
    errors.push("Iterations must be greater than 0");
  }
  return { ok: errors.length === 0, errors };
}
