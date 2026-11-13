/**
 * Local crash / session-fault diagnostics (ZR-160 / ZR-163).
 * Tauri-only; browser/dev returns a clear unavailable message.
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./index";

export type EngineFaultReport = {
  reason: string;
  launchId?: string;
  lastOp?: string;
  exitReason?: string;
  consecutiveStatusFailures?: number;
  protocol?: number;
};

/** Context for Solve failed / failed-phase reports (ZR-163). */
export type SolveFaultContext = {
  reason: string;
  /** e.g. solve-failed | solve-rpc-failed | session-dead | reconnect-ensure-fail */
  exitReason: string;
  iterations?: number | null;
  /** Board card count only (3/4/5) — no card text in diagnostics. */
  boardLen?: number | null;
  lastOp?: string;
  consecutiveStatusFailures?: number;
};

/** Dedupe sticky status failures so each poll does not rewrite the same fault. */
let lastSolveFaultKey: string | null = null;

export function resetSolveFaultDedupeForTests(): void {
  lastSolveFaultKey = null;
}

export function boardLenFromStatusBoard(
  board: unknown,
): number | null {
  if (Array.isArray(board)) {
    return board.length;
  }
  if (typeof board === "string" && board.trim()) {
    return board.trim().split(/\s+/).filter(Boolean).length;
  }
  return null;
}

/** Build reason string with safe dig context (iter + board_len only). */
export function formatSolveFaultReason(ctx: {
  reason: string;
  iterations?: number | null;
  boardLen?: number | null;
}): string {
  const base = ctx.reason.trim() || "Solve failed";
  const bits: string[] = [];
  if (ctx.iterations != null && Number.isFinite(Number(ctx.iterations))) {
    bits.push(`iter=${Number(ctx.iterations)}`);
  }
  if (ctx.boardLen != null && Number.isFinite(Number(ctx.boardLen))) {
    bits.push(`board_len=${Number(ctx.boardLen)}`);
  }
  return bits.length > 0 ? `${base} (${bits.join(", ")})` : base;
}

export async function openDiagnosticsFolder(): Promise<string> {
  if (!isTauriRuntime()) {
    throw new Error("Diagnostics folder requires the Holdem Study desktop app");
  }
  return (await invoke("open_diagnostics_folder")) as string;
}

/** Builds a zip and returns its absolute path (paste into chat/email). */
export async function copyDiagnosticsBundle(): Promise<string> {
  if (!isTauriRuntime()) {
    throw new Error("Diagnostics bundle requires the Holdem Study desktop app");
  }
  return (await invoke("copy_diagnostics_bundle")) as string;
}

export async function diagnosticsDirPath(): Promise<string> {
  if (!isTauriRuntime()) {
    throw new Error("Diagnostics path requires the Holdem Study desktop app");
  }
  return (await invoke("diagnostics_dir_path")) as string;
}

/** Best-effort last-fault.json update from session-dead / reconnect UI paths. */
export async function reportEngineFault(report: EngineFaultReport): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  try {
    await invoke("report_engine_fault", { report });
  } catch {
    // Must not block Reconnect / status paint.
  }
}

/**
 * Persist last-fault.json for every Solve failed / failed phase (ZR-163).
 * Dedupes identical sticky status faults; session-dead still overwrites via
 * reportEngineFault directly or a distinct exitReason.
 */
export async function reportSolveFailedFault(
  ctx: SolveFaultContext,
): Promise<void> {
  const reason = formatSolveFaultReason(ctx);
  const key = `${ctx.exitReason}|${reason}|${ctx.lastOp ?? ""}`;
  if (key === lastSolveFaultKey) {
    return;
  }
  lastSolveFaultKey = key;
  await reportEngineFault({
    reason,
    exitReason: ctx.exitReason,
    lastOp: ctx.lastOp,
    consecutiveStatusFailures: ctx.consecutiveStatusFailures,
    protocol: 2,
  });
}

/** Clear dedupe when starting a fresh Solve so a repeat fault is recorded. */
export function clearSolveFaultDedupe(): void {
  lastSolveFaultKey = null;
}

export async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  throw new Error("Clipboard unavailable");
}
