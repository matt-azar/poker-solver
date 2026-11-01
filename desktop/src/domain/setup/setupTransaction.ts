import { parseRangeText, snapshotWeights, type WeightSnapshot } from "../range";
import type { SpotDraft } from "../types";
import { bumpRevision, isStaleProposal } from "./revision";
import type {
  SetupDraftResult,
  SetupFieldProvenance,
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

export interface SetupTransactionSnapshot {
  draft: SpotDraft;
  weights: WeightSnapshot;
  meta: SetupStudyMeta | null;
  draftRevision: number;
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

/**
 * Apply a resolved setup draft as one undoable builder transaction.
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
  if (!patch || Object.keys(patch).length === 0) {
    return {
      ok: false,
      reason: "empty",
      message: "No setup changes to apply",
    };
  }

  const undoSnapshot: SetupTransactionSnapshot = {
    draft: { ...args.currentDraft },
    weights: snapshotWeights(args.currentWeights),
    meta: args.currentMeta ? { ...args.currentMeta, provenance: { ...args.currentMeta.provenance } } : null,
    draftRevision: args.draftRevision,
  };

  const nextDraft: SpotDraft = { ...args.currentDraft, ...patch };
  if (result.pot !== undefined) {
    nextDraft.pot = result.pot;
  }
  if (result.stack !== undefined) {
    nextDraft.stack = result.stack;
  }

  const nextWeights: WeightSnapshot = {
    oop:
      patch.oopRange !== undefined
        ? parseRangeText(patch.oopRange)
        : args.currentWeights.oop,
    ip:
      patch.ipRange !== undefined
        ? parseRangeText(patch.ipRange)
        : args.currentWeights.ip,
  };

  const meta = metaFromSetupResult(result);
  if (!meta.rangeSnapshot) {
    meta.rangeSnapshot = {
      oop: nextDraft.oopRange,
      ip: nextDraft.ipRange,
    };
  }

  return {
    ok: true,
    draft: nextDraft,
    weights: nextWeights,
    meta,
    draftRevision: bumpRevision(draftRevision),
    undoSnapshot,
  };
}
