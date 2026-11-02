import type { SpotDraft } from "../types";
import type { SetupConflict } from "./types";

/**
 * Field-specific limits for assistant/setup proposals.
 * Incomplete setups (missing board) stay separate from invalid proposed values.
 */
export const SETUP_FIELD_LIMITS = {
  pot: { minExclusive: 0, label: "Pot" },
  stack: { minExclusive: 0, label: "Stack" },
  memoryMib: { minInclusive: 0, label: "Memory" },
  threads: { minInclusive: 1, integer: true, label: "Threads" },
  iterations: { minInclusive: 1, integer: true, label: "Iterations" },
  samples: { minInclusive: 0, integer: true, label: "Samples" },
  maxRaises: { minInclusive: 0, integer: true, label: "Max raises" },
  mergeThresholdPct: { minInclusive: 0, label: "Merge threshold" },
  potCap: { minInclusive: 0, label: "Pot cap" },
  /** Engine solve rake rate (not range-source stakes label). */
  rakeRate: { minInclusive: 0, label: "Solve rake rate" },
  rakeCap: { minInclusive: 0, label: "Solve rake cap" },
} as const;

export type LimitedSetupField = keyof typeof SETUP_FIELD_LIMITS;

function conflict(field: string, message: string): SetupConflict {
  return { field, message };
}

/** Validate one proposed numeric Build field. */
export function validateLimitedField(
  field: LimitedSetupField,
  value: unknown,
): SetupConflict | null {
  const rule = SETUP_FIELD_LIMITS[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return conflict(field, `${rule.label} must be a finite number`);
  }
  if ("integer" in rule && rule.integer && !Number.isInteger(value)) {
    return conflict(field, `${rule.label} must be a whole number`);
  }
  if ("minExclusive" in rule && rule.minExclusive !== undefined) {
    if (!(value > rule.minExclusive)) {
      return conflict(field, `${rule.label} must be greater than ${rule.minExclusive}`);
    }
  }
  if ("minInclusive" in rule && rule.minInclusive !== undefined) {
    if (value < rule.minInclusive) {
      return conflict(
        field,
        rule.minInclusive === 0
          ? `${rule.label} cannot be negative`
          : `${rule.label} must be at least ${rule.minInclusive}`,
      );
    }
  }
  return null;
}

/**
 * Validate a bag of proposed field edits (assistant fieldEdits / explicit patch).
 * Returns conflicts for invalid values — callers must not mutate the draft.
 */
export function validateProposedFieldBag(
  fields: Partial<Record<LimitedSetupField, unknown>>,
): SetupConflict[] {
  const conflicts: SetupConflict[] = [];
  for (const key of Object.keys(SETUP_FIELD_LIMITS) as LimitedSetupField[]) {
    if (fields[key] === undefined) {
      continue;
    }
    const issue = validateLimitedField(key, fields[key]);
    if (issue) {
      conflicts.push(issue);
    }
  }
  return conflicts;
}

/** Validate numeric limits on a full (or partial) proposed draft. */
export function validateProposedDraftLimits(
  draft: Partial<SpotDraft>,
  keys?: LimitedSetupField[],
): SetupConflict[] {
  const check = keys ?? (Object.keys(SETUP_FIELD_LIMITS) as LimitedSetupField[]);
  const bag: Partial<Record<LimitedSetupField, unknown>> = {};
  for (const key of check) {
    if (draft[key] !== undefined) {
      bag[key] = draft[key];
    }
  }
  return validateProposedFieldBag(bag);
}
