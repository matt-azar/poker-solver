/**
 * Local crash / session-fault diagnostics (ZR-160 / ZR-163 / ZR-169).
 * Tauri-only; browser/dev returns a clear unavailable message.
 */
import { invoke } from "@tauri-apps/api/core";
import type { SolveJobRequest } from "../domain/types";
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
  /** Optional engine heap/peak bytes from status (budget dig). */
  engineAllocated?: number | null;
  enginePeak?: number | null;
  lastOp?: string;
  consecutiveStatusFailures?: number;
};

/**
 * Temporary UI-unresponsiveness signal kinds (ZR-173).
 * Soft status-poll timeouts that recover still leave evidence in
 * `ui-hang-events.json` without overwriting `last-fault.json`.
 */
export type UiHangEventKind =
  | "status-poll-timeout"
  | "status-poll-slow"
  | "status-poll-hung"
  | "main-thread-stall";

export type UiHangEventReport = {
  kind: UiHangEventKind;
  /** Wall duration of the stall / poll when known. */
  durationMs?: number;
  detail?: string;
  lastOp?: string;
  consecutiveStatusFailures?: number;
  /** Study phase at capture time (solving / building / …). */
  phase?: string;
};

/** Status poll duration above this is recorded as `status-poll-slow`. */
export const STATUS_POLL_SLOW_MS = 1_500;
/** Main-thread heartbeat gap above this is a stall (Not Responding class). */
export const MAIN_THREAD_STALL_MS = 2_000;
const MAIN_THREAD_HEARTBEAT_MS = 250;

/** Compact last-solve summary persisted before train start (ZR-169). */
export type LastSolveSummary = {
  snapshotKind: "pre-solve";
  trigger: "solve" | "continue";
  street: "flop" | "turn" | "river" | "unknown";
  boardLen: number;
  board: string[];
  pot: number;
  stack: number;
  iterations: number;
  accuracy: number | null;
  timeLimit: number | null;
  memoryMib: number | null;
  threads: number | null;
  algorithm: string | null;
  frozen: number | null;
  samples: number | null;
  rakeRate: number;
  rakeCap: number;
  useIcm: boolean;
  icmStacks: number[];
  icmPayouts: number[];
  potCap: number;
  allowThreeBet: number;
  allInThreshold: number;
  allowAllIn: number;
  maxRaises: number;
  mergeThreshold: number;
  /** Host default when the UI does not set cadence (app/session.zig). */
  publishEveryHint: number;
  betSizes: Record<string, number[]>;
  ranges: {
    oop: { seat: "oop"; chars: number; hash: string };
    ip: { seat: "ip"; chars: number; hash: string };
  };
  treeEditCount: number;
  incentiveCount: number;
  edgeTagCount: number;
};

/** Dedupe sticky status failures so each poll does not rewrite the same fault. */
let lastSolveFaultKey: string | null = null;

/** Last pre-solve summary (Continue reuses when draft rebuild is unavailable). */
let lastSolveSummaryCache: LastSolveSummary | null = null;

export function resetSolveFaultDedupeForTests(): void {
  lastSolveFaultKey = null;
  lastSolveSummaryCache = null;
}

export function lastSolveSummaryForTests(): LastSolveSummary | null {
  return lastSolveSummaryCache;
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

function formatMiB(bytes: number | null | undefined): string | null {
  if (bytes == null || !Number.isFinite(Number(bytes)) || Number(bytes) <= 0) {
    return null;
  }
  return `${(Number(bytes) / (1024 * 1024)).toFixed(1)}MiB`;
}

/** Build reason string with safe dig context (no board cards / ranges). */
export function formatSolveFaultReason(ctx: {
  reason: string;
  iterations?: number | null;
  boardLen?: number | null;
  engineAllocated?: number | null;
  enginePeak?: number | null;
}): string {
  const base = ctx.reason.trim() || "Solve failed";
  const bits: string[] = [];
  if (ctx.iterations != null && Number.isFinite(Number(ctx.iterations))) {
    bits.push(`iter=${Number(ctx.iterations)}`);
  }
  if (ctx.boardLen != null && Number.isFinite(Number(ctx.boardLen))) {
    bits.push(`board_len=${Number(ctx.boardLen)}`);
  }
  const peak = formatMiB(ctx.enginePeak ?? null);
  if (peak) {
    bits.push(`peak=${peak}`);
  }
  const allocated = formatMiB(ctx.engineAllocated ?? null);
  if (allocated) {
    bits.push(`alloc=${allocated}`);
  }
  return bits.length > 0 ? `${base} (${bits.join(", ")})` : base;
}

/** FNV-1a 32-bit — compact range fingerprint without dumping catalogues. */
export function compactTextHash(text: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function streetFromBoardLen(len: number): LastSolveSummary["street"] {
  if (len === 3) return "flop";
  if (len === 4) return "turn";
  if (len === 5) return "river";
  return "unknown";
}

function pickBetSizes(job: SolveJobRequest): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  const keys: Array<keyof SolveJobRequest> = [
    "oop_bets",
    "ip_bets",
    "oop_raises",
    "ip_raises",
    "oop_flop_bets",
    "ip_flop_bets",
    "oop_turn_bets",
    "ip_turn_bets",
    "oop_river_bets",
    "ip_river_bets",
    "oop_flop_raises",
    "ip_flop_raises",
    "oop_turn_raises",
    "ip_turn_raises",
    "oop_river_raises",
    "ip_river_raises",
    "oop_donk",
    "oop_flop_donk",
    "oop_turn_donk",
    "oop_river_donk",
    "oop_raise_multiples",
    "ip_raise_multiples",
  ];
  for (const key of keys) {
    const value = job[key];
    if (Array.isArray(value) && value.length > 0) {
      out[key] = value.map((n) => Number(n));
    }
  }
  return out;
}

/**
 * Compact solve parameters for diagnostics (no full range text / secrets).
 */
export function summarizeLastSolve(
  job: SolveJobRequest,
  trigger: "solve" | "continue" = "solve",
): LastSolveSummary {
  const board = Array.isArray(job.board) ? job.board.map(String) : [];
  const boardLen = board.length;
  const oopRange = String(job.oop_range ?? "");
  const ipRange = String(job.ip_range ?? "");
  const icmStacks = Array.isArray(job.icm_stacks) ? job.icm_stacks.map(Number) : [];
  const icmPayouts = Array.isArray(job.icm_payouts) ? job.icm_payouts.map(Number) : [];
  return {
    snapshotKind: "pre-solve",
    trigger,
    street: streetFromBoardLen(boardLen),
    boardLen,
    board,
    pot: Number(job.pot) || 0,
    stack: Number(job.stack) || 0,
    iterations: Math.max(1, Math.trunc(Number(job.iterations) || 1)),
    accuracy:
      typeof job.accuracy === "number" && Number.isFinite(job.accuracy)
        ? job.accuracy
        : null,
    timeLimit:
      typeof job.time_limit === "number" && Number.isFinite(job.time_limit)
        ? job.time_limit
        : null,
    memoryMib:
      typeof job.memory_mib === "number" && Number.isFinite(job.memory_mib)
        ? Math.trunc(job.memory_mib)
        : null,
    threads:
      typeof job.threads === "number" && Number.isFinite(job.threads)
        ? Math.trunc(job.threads)
        : null,
    algorithm: job.algorithm ? String(job.algorithm) : null,
    frozen:
      typeof job.frozen === "number" && Number.isFinite(job.frozen)
        ? job.frozen
        : null,
    samples:
      typeof job.samples === "number" && Number.isFinite(job.samples)
        ? Math.trunc(job.samples)
        : null,
    rakeRate: Number(job.rake_rate) || 0,
    rakeCap: Number(job.rake_cap) || 0,
    useIcm: icmStacks.length >= 2,
    icmStacks,
    icmPayouts,
    potCap: Number(job.pot_cap) || 0,
    allowThreeBet: Number(job.allow_three_bet ?? 1),
    allInThreshold: Number(job.all_in_threshold) || 0,
    allowAllIn: Number(job.allow_all_in ?? 0),
    maxRaises: Number(job.max_raises ?? 2),
    mergeThreshold: Number(job.merge_threshold) || 0,
    publishEveryHint: 10,
    betSizes: pickBetSizes(job),
    ranges: {
      oop: {
        seat: "oop",
        chars: oopRange.length,
        hash: compactTextHash(oopRange),
      },
      ip: {
        seat: "ip",
        chars: ipRange.length,
        hash: compactTextHash(ipRange),
      },
    },
    treeEditCount: Array.isArray(job.tree_edits) ? job.tree_edits.length : 0,
    incentiveCount: Array.isArray(job.incentives) ? job.incentives.length : 0,
    edgeTagCount: Array.isArray(job.edge_tags) ? job.edge_tags.length : 0,
  };
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

/**
 * Write last-solve + cheap host-resources before train starts (ZR-169).
 * Best-effort; never throws into the Solve path.
 */
export async function persistPreSolveDiagnostics(
  summary: LastSolveSummary,
): Promise<void> {
  lastSolveSummaryCache = summary;
  if (!isTauriRuntime()) {
    return;
  }
  try {
    await invoke("persist_pre_solve_diagnostics", { summary });
  } catch {
    // Must not delay or fail Solve / Continue.
  }
}

/**
 * Continue train: reuse last solve params, overlay new stop criteria.
 * Falls back to `summary` when there was no prior Solve in this session.
 */
export function summarizeContinueSolve(
  fallback: LastSolveSummary | null,
  opts: { iterations: number; timeLimit?: number | null },
): LastSolveSummary | null {
  const base = fallback ?? lastSolveSummaryCache;
  if (!base) {
    return null;
  }
  return {
    ...base,
    snapshotKind: "pre-solve",
    trigger: "continue",
    iterations: Math.max(1, Math.trunc(opts.iterations || base.iterations)),
    timeLimit:
      opts.timeLimit != null && Number.isFinite(opts.timeLimit)
        ? opts.timeLimit
        : base.timeLimit,
  };
}

export async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  throw new Error("Clipboard unavailable");
}

/**
 * Append one hang/unresponsiveness signal to ui-hang-events.json (ZR-173).
 * Best-effort; never throws into status poll / paint paths.
 */
export async function reportUiHangEvent(report: UiHangEventReport): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  const kind = report.kind?.trim();
  if (!kind) {
    return;
  }
  try {
    await invoke("report_ui_hang_event", {
      report: {
        kind,
        durationMs:
          report.durationMs != null && Number.isFinite(report.durationMs)
            ? Math.max(0, Math.round(Number(report.durationMs)))
            : undefined,
        detail: report.detail,
        lastOp: report.lastOp,
        consecutiveStatusFailures: report.consecutiveStatusFailures,
        phase: report.phase,
      },
    });
  } catch {
    // Must not block status paint / Reconnect.
  }
}

type HangMonitorHandle = {
  stop: () => void;
};

let hangMonitor: HangMonitorHandle | null = null;

/**
 * Cheap main-thread stall detector for packaged Study (ZR-173).
 * Interval heartbeat: a gap >> interval means the UI thread was blocked
 * (sync IPC, heavy JS, or OS "Not Responding"). Records once per stall when
 * the thread resumes. No-op outside Tauri / when already running.
 */
export function startUiHangMonitor(opts?: {
  stallMs?: number;
  heartbeatMs?: number;
}): void {
  if (!isTauriRuntime()) {
    return;
  }
  if (hangMonitor) {
    return;
  }
  if (typeof window === "undefined" || typeof window.setInterval !== "function") {
    return;
  }
  const stallMs = Math.max(500, opts?.stallMs ?? MAIN_THREAD_STALL_MS);
  const heartbeatMs = Math.max(100, opts?.heartbeatMs ?? MAIN_THREAD_HEARTBEAT_MS);
  let lastBeat = Date.now();
  let stallOpen = false;
  const timer = window.setInterval(() => {
    const now = Date.now();
    const gap = now - lastBeat;
    lastBeat = now;
    if (gap >= stallMs) {
      if (!stallOpen) {
        stallOpen = true;
        void reportUiHangEvent({
          kind: "main-thread-stall",
          durationMs: gap,
          detail: `main-thread gap ${gap}ms (heartbeat ${heartbeatMs}ms)`,
          lastOp: "ui-heartbeat",
        });
      }
    } else {
      stallOpen = false;
    }
  }, heartbeatMs);
  hangMonitor = {
    stop: () => {
      window.clearInterval(timer);
    },
  };
}

/** Stop the main-thread hang monitor (tests / shutdown). */
export function stopUiHangMonitor(): void {
  hangMonitor?.stop();
  hangMonitor = null;
}

/** Test helper: is the hang monitor currently scheduled? */
export function uiHangMonitorActiveForTests(): boolean {
  return hangMonitor != null;
}
