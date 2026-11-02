import { parseRangeText, snapshotWeights, type WeightSnapshot } from "../range";
import { DEFAULT_SPOT, type SpotDraft } from "../types";
import { createBlankSetupDraft } from "./apply";
import { bumpRevision, isStaleProposal } from "./revision";
import type {
  SetupDraftResult,
  SetupFieldProvenance,
  SetupMode,
  SetupProfileRef,
} from "./types";

export interface SetupStudyMeta {
  profile: SetupProfileRef | null;
  /** Actual range strings applied (reopen must not require live catalogue). */
  rangeSnapshot: { oop: string; ip: string } | null;
  profileDataRevision: string | number | null;
  provenance: Record<string, SetupFieldProvenance>;
  summary: string[];
  conflicts: SetupDraftResult["conflicts"];
  missing: SetupDraftResult["missing"];
  canSolve: boolean;
}

/**
 * Full pre-apply snapshot kept for archaeology / migration; undo uses the
 * guarded field-level {@link SetupUndoEntry} instead of restoring wholesale.
 */
export interface SetupTransactionSnapshot {
  draft: SpotDraft;
  weights: WeightSnapshot;
  meta: SetupStudyMeta | null;
  draftRevision: number;
}

/**
 * Guarded inverse for one assistant/setup apply. Undo restores only keys whose
 * current value still matches `afterDraft` (not subsequently overwritten).
 */
export interface SetupUndoEntry {
  operationId: string;
  mode: SetupMode;
  changedKeys: (keyof SpotDraft)[];
  beforeDraft: Partial<SpotDraft>;
  afterDraft: Partial<SpotDraft>;
  rangesChanged: boolean;
  beforeWeights: WeightSnapshot | null;
  afterWeights: WeightSnapshot | null;
  beforeMeta: SetupStudyMeta | null;
  afterMeta: SetupStudyMeta;
  baseRevision: number;
  resultRevision: number;
  /** Full snapshot before apply (not used for guarded restore). */
  fullBefore: SetupTransactionSnapshot;
}

export const EMPTY_SETUP_META: SetupStudyMeta = {
  profile: null,
  rangeSnapshot: null,
  profileDataRevision: null,
  provenance: {},
  summary: [],
  conflicts: [],
  missing: [],
  canSolve: false,
};

let setupOperationSeq = 0;

export function metaFromSetupResult(result: SetupDraftResult): SetupStudyMeta {
  const oop = result.draftPatch.oopRange;
  const ip = result.draftPatch.ipRange;
  return {
    profile: result.profile ?? null,
    rangeSnapshot:
      oop !== undefined || ip !== undefined
        ? { oop: oop ?? "", ip: ip ?? "" }
        : null,
    profileDataRevision: result.profile?.revision ?? null,
    provenance: { ...result.provenance },
    summary: [...result.summary],
    conflicts: [...result.conflicts],
    missing: [...result.missing],
    canSolve: result.canSolve,
  };
}

export interface ApplySetupTransactionArgs {
  currentDraft: SpotDraft;
  currentWeights: WeightSnapshot;
  currentMeta: SetupStudyMeta | null;
  draftRevision: number;
  result: SetupDraftResult;
  /** When true, ignore conflicts and still merge draftPatch (preview already shown). */
  force?: boolean;
}

export interface ApplySetupTransactionOk {
  ok: true;
  draft: SpotDraft;
  weights: WeightSnapshot;
  meta: SetupStudyMeta;
  draftRevision: number;
  undoEntry: SetupUndoEntry;
  /** @deprecated Prefer undoEntry; kept as alias of undoEntry.fullBefore. */
  undoSnapshot: SetupTransactionSnapshot;
}

export interface ApplySetupTransactionErr {
  ok: false;
  reason: "stale" | "blocked" | "empty";
  message: string;
}

export type ApplySetupTransactionResult =
  | ApplySetupTransactionOk
  | ApplySetupTransactionErr;

function draftValuesEqual(left: unknown, right: unknown): boolean {
  if (typeof left === "number" && typeof right === "number") {
    return Math.abs(left - right) < 1e-9;
  }
  return left === right;
}

function cloneMeta(meta: SetupStudyMeta | null): SetupStudyMeta | null {
  if (!meta) {
    return null;
  }
  return {
    ...meta,
    provenance: { ...meta.provenance },
    summary: [...meta.summary],
    conflicts: [...meta.conflicts],
    missing: [...meta.missing],
    rangeSnapshot: meta.rangeSnapshot
      ? { oop: meta.rangeSnapshot.oop, ip: meta.rangeSnapshot.ip }
      : null,
    profile: meta.profile ? { ...meta.profile } : null,
  };
}

function collectChangedKeys(
  before: SpotDraft,
  after: SpotDraft,
): (keyof SpotDraft)[] {
  const keys = Object.keys(DEFAULT_SPOT) as (keyof SpotDraft)[];
  const changed: (keyof SpotDraft)[] = [];
  for (const key of keys) {
    if (!draftValuesEqual(before[key], after[key])) {
      changed.push(key);
    }
  }
  return changed;
}

function pickDraftFields(
  draft: SpotDraft,
  keys: (keyof SpotDraft)[],
): Partial<SpotDraft> {
  const out: Partial<SpotDraft> = {};
  for (const key of keys) {
    (out as Record<string, unknown>)[key] = draft[key];
  }
  return out;
}

/**
 * Apply a resolved setup draft as one undoable builder transaction.
 * Create / duplicate replace from a blank (or duplicated) base so leftover
 * live-draft fields (board, solution path) cannot survive a partial patch.
 * Stale proposals (revision mismatch) are rejected without mutating state.
 */
export function applySetupTransaction(
  args: ApplySetupTransactionArgs,
): ApplySetupTransactionResult {
  const { result, draftRevision } = args;
  if (isStaleProposal(result.requestRevision, draftRevision)) {
    return {
      ok: false,
      reason: "stale",
      message: "Setup changed while the assistant ran — regenerate the proposal",
    };
  }

  if (!args.force && result.conflicts.length > 0) {
    return {
      ok: false,
      reason: "blocked",
      message: result.conflicts.map((c) => c.message).join("; ") || "Conflicts must be resolved",
    };
  }

  const patch = result.draftPatch;
  const mode: SetupMode = result.mode ?? "edit";
  if (!patch || Object.keys(patch).length === 0) {
    return {
      ok: false,
      reason: "empty",
      message: "No setup changes to apply",
    };
  }

  const fullBefore: SetupTransactionSnapshot = {
    draft: { ...args.currentDraft },
    weights: snapshotWeights(args.currentWeights),
    meta: cloneMeta(args.currentMeta),
    draftRevision: args.draftRevision,
  };

  // Create/duplicate commit against the same blank/copy base used for validation,
  // not a shallow merge onto whatever happens to be live in the builder.
  const applyBase: SpotDraft =
    mode === "create"
      ? createBlankSetupDraft("create", args.currentDraft)
      : mode === "duplicate"
        ? createBlankSetupDraft("duplicate", args.currentDraft)
        : args.currentDraft;

  const nextDraft: SpotDraft = { ...applyBase, ...patch };
  if (result.pot !== undefined) {
    nextDraft.pot = result.pot;
  }
  if (result.stack !== undefined) {
    nextDraft.stack = result.stack;
  }
  if (mode === "create" || mode === "duplicate") {
    // Never inherit a prior solve output path into a new study identity.
    if (patch.solutionPath === undefined) {
      nextDraft.solutionPath = "";
    }
  }

  const nextWeights: WeightSnapshot = {
    oop:
      patch.oopRange !== undefined
        ? parseRangeText(patch.oopRange)
        : mode === "create"
          ? parseRangeText(nextDraft.oopRange)
          : args.currentWeights.oop,
    ip:
      patch.ipRange !== undefined
        ? parseRangeText(patch.ipRange)
        : mode === "create"
          ? parseRangeText(nextDraft.ipRange)
          : args.currentWeights.ip,
  };

  const meta = metaFromSetupResult(result);
  if (!meta.rangeSnapshot) {
    meta.rangeSnapshot = {
      oop: nextDraft.oopRange,
      ip: nextDraft.ipRange,
    };
  }

  const resultRevision = bumpRevision(draftRevision);
  const changedKeys = collectChangedKeys(args.currentDraft, nextDraft);
  const rangesChanged =
    changedKeys.includes("oopRange") || changedKeys.includes("ipRange");

  const undoEntry: SetupUndoEntry = {
    operationId: `setup-${resultRevision}-${++setupOperationSeq}`,
    mode,
    changedKeys,
    beforeDraft: pickDraftFields(args.currentDraft, changedKeys),
    afterDraft: pickDraftFields(nextDraft, changedKeys),
    rangesChanged,
    beforeWeights: rangesChanged ? snapshotWeights(args.currentWeights) : null,
    afterWeights: rangesChanged ? snapshotWeights(nextWeights) : null,
    beforeMeta: cloneMeta(args.currentMeta),
    afterMeta: cloneMeta(meta)!,
    baseRevision: draftRevision,
    resultRevision,
    fullBefore,
  };

  return {
    ok: true,
    draft: nextDraft,
    weights: nextWeights,
    meta,
    draftRevision: resultRevision,
    undoEntry,
    undoSnapshot: fullBefore,
  };
}

export interface UndoSetupTransactionArgs {
  currentDraft: SpotDraft;
  currentWeights: WeightSnapshot;
  currentMeta: SetupStudyMeta | null;
  draftRevision: number;
  entry: SetupUndoEntry;
}

export interface UndoSetupTransactionResult {
  draft: SpotDraft;
  weights: WeightSnapshot;
  meta: SetupStudyMeta | null;
  draftRevision: number;
  restoredKeys: (keyof SpotDraft)[];
  conflictKeys: (keyof SpotDraft)[];
  message: string;
}

/**
 * Guarded inverse of {@link applySetupTransaction}: restore only fields the
 * operation changed, and only when they still match the post-apply values.
 */
export function undoSetupTransactionGuarded(
  args: UndoSetupTransactionArgs,
): UndoSetupTransactionResult {
  const { entry } = args;
  const nextDraft: SpotDraft = { ...args.currentDraft };
  const restoredKeys: (keyof SpotDraft)[] = [];
  const conflictKeys: (keyof SpotDraft)[] = [];

  for (const key of entry.changedKeys) {
    const afterValue = entry.afterDraft[key];
    const beforeValue = entry.beforeDraft[key];
    if (draftValuesEqual(args.currentDraft[key], afterValue)) {
      (nextDraft as Record<string, unknown>)[key] = beforeValue;
      restoredKeys.push(key);
    } else {
      conflictKeys.push(key);
    }
  }

  let nextWeights = snapshotWeights(args.currentWeights);
  if (entry.rangesChanged && entry.beforeWeights) {
    const oopOk =
      !entry.changedKeys.includes("oopRange") ||
      restoredKeys.includes("oopRange");
    const ipOk =
      !entry.changedKeys.includes("ipRange") ||
      restoredKeys.includes("ipRange");
    nextWeights = {
      oop: oopOk ? snapshotWeights(entry.beforeWeights).oop : nextWeights.oop,
      ip: ipOk ? snapshotWeights(entry.beforeWeights).ip : nextWeights.ip,
    };
    // If a range key was skipped due to conflict, keep current weights for that side.
    if (entry.changedKeys.includes("oopRange") && conflictKeys.includes("oopRange")) {
      nextWeights.oop = args.currentWeights.oop;
    }
    if (entry.changedKeys.includes("ipRange") && conflictKeys.includes("ipRange")) {
      nextWeights.ip = args.currentWeights.ip;
    }
  }

  const nextMeta =
    conflictKeys.length === 0 ? cloneMeta(entry.beforeMeta) : args.currentMeta;

  let message: string;
  if (conflictKeys.length === 0) {
    message =
      restoredKeys.length > 0
        ? "Reverted assistant setup"
        : "Nothing to revert — setup already matched the prior state";
  } else if (restoredKeys.length === 0) {
    message = `Could not revert assistant setup — later edits changed ${conflictKeys.join(", ")}`;
  } else {
    message = `Reverted ${restoredKeys.join(", ")}; kept later edits to ${conflictKeys.join(", ")}`;
  }

  return {
    draft: nextDraft,
    weights: nextWeights,
    meta: nextMeta,
    draftRevision: bumpRevision(args.draftRevision),
    restoredKeys,
    conflictKeys,
    message,
  };
}
