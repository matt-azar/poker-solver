import type { SpotDraft } from "../types";
import type {
  SetupConflict,
  SetupDraftResult,
  SetupFieldProvenance,
  SetupMissing,
  SetupMode,
} from "../setup/types";
import type { SetupUndoEntry } from "../setup/setupTransaction";

/** Structured receipt for a committed assistant / setup application. */
export interface ApplicationReceiptFieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface ApplicationReceipt {
  operationId: string;
  committedRevision: number;
  baseRevision: number;
  mode: SetupMode;
  changedFields: ApplicationReceiptFieldChange[];
  rangesChanged: boolean;
  /** Provenance tags for range (and related) fields from the applied result. */
  rangeSources: Partial<Record<string, SetupFieldProvenance>>;
  unresolved: SetupMissing[];
  conflicts: SetupConflict[];
  canSolve: boolean;
  summaryLines: string[];
  /**
   * True for create/duplicate or multi-field setups — chat may show a compact
   * review card. Direct scalar edits stay automatic/reversible without a modal.
   */
  broadSetup: boolean;
}

const FIELD_LABELS: Partial<Record<keyof SpotDraft, string>> = {
  pot: "Pot",
  stack: "Stack",
  boardText: "Board",
  oopRange: "OOP range",
  ipRange: "IP range",
  iterations: "Iterations",
  accuracy: "Accuracy",
  timeLimit: "Time limit",
  threads: "Threads",
  memoryMib: "Memory",
  algorithm: "Algorithm",
  samples: "Samples",
  maxRaises: "Max raises",
  potCap: "Pot cap",
  rakeRate: "Solve rake rate",
  rakeCap: "Solve rake cap",
  oopBets: "OOP bets",
  ipBets: "IP bets",
  oopRaises: "OOP raises",
  ipRaises: "IP raises",
  oopFlop: "OOP flop",
  ipFlop: "IP flop",
  oopTurn: "OOP turn",
  ipTurn: "IP turn",
  oopRiver: "OOP river",
  ipRiver: "IP river",
  oopDonk: "OOP donk",
  oopFlopRaises: "OOP flop raises",
  ipFlopRaises: "IP flop raises",
  oopTurnRaises: "OOP turn raises",
  ipTurnRaises: "IP turn raises",
  oopRiverRaises: "OOP river raises",
  ipRiverRaises: "IP river raises",
  oopFlopDonk: "Flop donk",
  oopTurnDonk: "Turn donk",
  oopRiverDonk: "River donk",
  solutionPath: "Solution path",
  incentives: "Incentives",
  edgeTags: "Edge tags",
};

const RANGE_SOURCE_KEYS = ["oopRange", "ipRange", "stakesLabel"] as const;

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field as keyof SpotDraft] ?? field;
}

function formatScalar(value: unknown): string {
  if (value === undefined) return "(unset)";
  if (value === null) return "(null)";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "(empty)";
    return trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed;
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return String(value);
    return Number.isInteger(value) ? String(value) : String(value);
  }
  return JSON.stringify(value);
}

/**
 * Build a receipt from the transaction undo entry plus the applied setup result.
 */
export function buildApplicationReceipt(args: {
  undoEntry: SetupUndoEntry;
  result: SetupDraftResult;
}): ApplicationReceipt {
  const { undoEntry, result } = args;
  const changedFields: ApplicationReceiptFieldChange[] = undoEntry.changedKeys.map(
    (field) => ({
      field: String(field),
      before: undoEntry.beforeDraft[field],
      after: undoEntry.afterDraft[field],
    }),
  );

  const rangeSources: ApplicationReceipt["rangeSources"] = {};
  for (const key of RANGE_SOURCE_KEYS) {
    const tag = result.provenance[key];
    if (tag) rangeSources[key] = tag;
  }

  const broadSetup =
    undoEntry.mode === "create" ||
    undoEntry.mode === "duplicate" ||
    changedFields.length > 3 ||
    undoEntry.rangesChanged;

  return {
    operationId: undoEntry.operationId,
    committedRevision: undoEntry.resultRevision,
    baseRevision: undoEntry.baseRevision,
    mode: undoEntry.mode,
    changedFields,
    rangesChanged: undoEntry.rangesChanged,
    rangeSources,
    unresolved: [...result.missing],
    conflicts: [...result.conflicts],
    canSolve: result.canSolve,
    summaryLines: [...result.summary],
    broadSetup,
  };
}

/**
 * Render assistant chat text FROM the receipt (actual applied changes),
 * not the model's intended action.
 *
 * Example: "Pot: 100 → 55. Other fields unchanged. Build draft updated."
 */
export function renderReceiptChatText(receipt: ApplicationReceipt): string {
  if (receipt.changedFields.length === 0) {
    return "No fields changed. Build draft unchanged.";
  }

  const changeLines = receipt.changedFields.map((change) => {
    const label = fieldLabel(change.field);
    return `${label}: ${formatScalar(change.before)} → ${formatScalar(change.after)}`;
  });

  const parts: string[] = [];
  if (changeLines.length === 1) {
    parts.push(`${changeLines[0]}. Other fields unchanged.`);
  } else {
    parts.push(changeLines.join(". ") + ".");
  }

  if (receipt.mode === "create") {
    parts.push("New study created.");
  } else if (receipt.mode === "duplicate") {
    parts.push("Study duplicated.");
  } else {
    parts.push("Build draft updated.");
  }

  if (Object.keys(receipt.rangeSources).length > 0) {
    const src = Object.entries(receipt.rangeSources)
      .map(([field, tag]) => `${fieldLabel(field)}=${tag}`)
      .join(", ");
    parts.push(`Range sources: ${src}.`);
  }

  if (receipt.unresolved.length > 0) {
    parts.push(
      `Unresolved: ${receipt.unresolved.map((m) => `${m.field} (${m.message})`).join("; ")}.`,
    );
  }

  if (receipt.conflicts.length > 0) {
    parts.push(
      `Conflicts noted: ${receipt.conflicts.map((c) => c.message).join("; ")}.`,
    );
  }

  return parts.join(" ");
}

/** Compact multi-line review body for broad setups (shown in chat, not a modal). */
export function renderReceiptReviewCard(receipt: ApplicationReceipt): string {
  const lines = [
    `Review · ${receipt.mode} · rev ${receipt.baseRevision} → ${receipt.committedRevision}`,
    `op ${receipt.operationId}`,
  ];
  for (const change of receipt.changedFields) {
    lines.push(
      `• ${fieldLabel(change.field)}: ${formatScalar(change.before)} → ${formatScalar(change.after)}`,
    );
  }
  if (Object.keys(receipt.rangeSources).length > 0) {
    lines.push(
      `Sources: ${Object.entries(receipt.rangeSources)
        .map(([f, t]) => `${fieldLabel(f)}=${t}`)
        .join(", ")}`,
    );
  }
  for (const miss of receipt.unresolved) {
    lines.push(`Missing ${miss.field}: ${miss.message}`);
  }
  lines.push(receipt.canSolve ? "Ready to solve." : "Not yet solvable.");
  return lines.join("\n");
}

/** Full chat content for a successful apply: receipt text + optional review card. */
export function chatContentFromReceipt(receipt: ApplicationReceipt): string {
  const body = renderReceiptChatText(receipt);
  if (!receipt.broadSetup) {
    return body;
  }
  return `${body}\n\n${renderReceiptReviewCard(receipt)}`;
}

/** True when the resolved result carries at least one Build patch field. */
export function setupResultHasApplyablePatch(result: SetupDraftResult): boolean {
  return Object.keys(result.draftPatch ?? {}).length > 0;
}

/**
 * Broad setups (new study, duplicate, range replacement, many fields) should
 * show an explicit Apply control. Narrow scalar edits auto-commit.
 */
export function setupResultIsBroad(result: SetupDraftResult): boolean {
  if (result.mode === "create" || result.mode === "duplicate") {
    return true;
  }
  const patch = result.draftPatch ?? {};
  if (patch.oopRange !== undefined || patch.ipRange !== undefined) {
    return true;
  }
  return Object.keys(patch).length > 3;
}

/** Compact pending-proposal body shown before the player clicks Apply. */
export function renderPendingSetupReview(result: SetupDraftResult): string {
  const patch = result.draftPatch ?? {};
  const keys = Object.keys(patch);
  const lines: string[] = [`Review · ${result.mode} · rev ${result.requestRevision}`];
  if (keys.length === 0) {
    lines.push("• (no Build fields in this proposal)");
  } else {
    for (const key of keys) {
      lines.push(
        `• ${fieldLabel(key)}: ${formatScalar(patch[key as keyof typeof patch])}`,
      );
    }
  }
  for (const miss of result.missing) {
    lines.push(`Missing ${miss.field}: ${miss.message}`);
  }
  for (const conflict of result.conflicts) {
    lines.push(`Conflict ${conflict.field}: ${conflict.message}`);
  }
  lines.push(
    result.canSolve
      ? "Ready to solve after Apply."
      : "Not yet solvable after Apply — fill remaining Build fields.",
  );
  lines.push("Click Apply to write these onto Build (Undo available afterward).");
  return lines.join("\n");
}
