/**
 * Job lifecycle intent for Study IPC (audit §7 / prompt §6).
 *
 * Pure domain helpers for composite Build→Train handoff, active-job commit
 * rules, Open reset of job-local targets, train wire shape (samples), and
 * clearly named identity fields. Ready for studyStore / EngineClient wire-up
 * (IPC-6 remainder) — this module must not import engine transport or the store.
 *
 * Identity vocabulary (do not conflate):
 * - {@link LaunchId}: sidecar process / connection — restart and hung-kill only.
 * - {@link PolicyRevision}: published strategy / average epoch.
 * - {@link StatusSequence}: status-path ordering counter (host `status_generation`
 *   formula on the status reply). Not equity generation.
 * - {@link EquityGeneration}: equity-reply generation (host uses solution_id +
 *   policy_revision). Not comparable to StatusSequence.
 */

/** Sidecar launch / connection id — use for restart and launch-scoped kill. */
export type LaunchId = string;

/** Published strategy / average epoch — bumps when averages publish. */
export type PolicyRevision = number;

/**
 * Status-path sequence from host status replies (`status_generation` on status).
 * Distinct from {@link EquityGeneration} and from analysis supersession gens.
 */
export type StatusSequence = number;

/**
 * Equity analysis reply generation. Host currently packs solution_id +
 * policy_revision into a field also named `status_generation` on equity
 * replies — callers must treat that as EquityGeneration, not StatusSequence.
 */
export type EquityGeneration = number;

/** Documented study identity scopes for later wire-up. */
export interface StudyIdentityScopes {
  /** Sidecar launch — restart / kill scoping only. */
  launchId: LaunchId | null;
  /** Strategy data freshness. */
  policyRevision: PolicyRevision | null;
  /** Status poll / status reply ordering. */
  statusSequence: StatusSequence | null;
  /** Equity reply generation — never interchange with statusSequence. */
  equityGeneration: EquityGeneration | null;
}

export type CompositeSolvePhase =
  | "building"
  | "awaiting_train"
  | "training"
  | "terminal";

/**
 * One cancellable intent spanning begin_config (Build) and train admission.
 * Client latches cancel before sending train; host admission must also refuse
 * a latched/cancelled job id.
 */
export interface CompositeSolveIntent {
  jobId: string;
  phase: CompositeSolvePhase;
  /** Stop observed before train was written — do not send train. */
  cancelLatched: boolean;
  /** Host admitted train for this job (`accepted` / `running`). */
  trainAdmitted: boolean;
}

export function createCompositeSolveIntent(jobId: string): CompositeSolveIntent {
  const id = jobId.trim();
  if (!id) {
    throw new Error("contract: composite solve intent requires a non-empty jobId");
  }
  return {
    jobId: id,
    phase: "building",
    cancelLatched: false,
    trainAdmitted: false,
  };
}

/** Latch Stop during Build / pre-train so the handoff cannot admit train. */
export function latchSolveCancel(intent: CompositeSolveIntent): CompositeSolveIntent {
  if (intent.phase === "terminal") {
    return intent;
  }
  return { ...intent, cancelLatched: true };
}

/**
 * True while Stop should apply to this composite intent even if the host
 * still reports `not_running` (compile finished, train not yet admitted).
 */
export function stopAppliesDuringBuild(intent: CompositeSolveIntent): boolean {
  return (
    !intent.trainAdmitted &&
    (intent.phase === "building" || intent.phase === "awaiting_train")
  );
}

/**
 * Whether the desktop client may send the train request after Build succeeds.
 * Cancel latch or terminal phase blocks the handoff (client-side gate).
 */
export function maySendTrain(intent: CompositeSolveIntent): boolean {
  if (intent.cancelLatched) {
    return false;
  }
  if (intent.phase === "terminal" || intent.trainAdmitted) {
    return false;
  }
  return intent.phase === "building" || intent.phase === "awaiting_train";
}

/**
 * Host admission check model: refuse train when the job was cancelled or
 * another train already owns the session (busy). Pure predicate for tests /
 * later host mirror — not a wire call.
 */
export function hostMayAdmitTrain(args: {
  jobId: string;
  cancelLatched: boolean;
  sessionBusy: boolean;
  expectedJobId?: string | null;
}): boolean {
  if (args.cancelLatched) {
    return false;
  }
  if (args.sessionBusy) {
    return false;
  }
  if (args.expectedJobId != null && args.expectedJobId !== args.jobId) {
    return false;
  }
  return args.jobId.trim().length > 0;
}

export function noteBuildComplete(intent: CompositeSolveIntent): CompositeSolveIntent {
  if (intent.phase === "terminal" || intent.trainAdmitted) {
    return intent;
  }
  return { ...intent, phase: "awaiting_train" };
}

export function noteTrainAdmitted(intent: CompositeSolveIntent): CompositeSolveIntent {
  if (intent.cancelLatched) {
    return { ...intent, phase: "terminal", trainAdmitted: false };
  }
  return {
    ...intent,
    phase: "training",
    trainAdmitted: true,
  };
}

export function noteSolveTerminal(intent: CompositeSolveIntent): CompositeSolveIntent {
  return { ...intent, phase: "terminal" };
}

/** Authoritative vs pending Study train job ids for Stop/Pause defaults. */
export interface JobIdBook {
  /** Host-admitted (or last successfully admitted) job — default Stop/Pause. */
  activeJobId: string | null;
  /** Freshly minted id awaiting admission; never used for default Stop. */
  pendingJobId: string | null;
}

export function emptyJobIdBook(): JobIdBook {
  return { activeJobId: null, pendingJobId: null };
}

/** Mint / stage a pending job id without promoting it to active. */
export function beginPendingJob(book: JobIdBook, pendingJobId: string): JobIdBook {
  const id = pendingJobId.trim();
  if (!id) {
    throw new Error("contract: pending job id must be non-empty");
  }
  return { ...book, pendingJobId: id };
}

export function isTrainAdmissionSuccess(reply: {
  accepted?: boolean;
  running?: boolean;
  busy?: boolean;
  error_code?: string | null;
}): boolean {
  if (reply.busy === true) {
    return false;
  }
  const code = typeof reply.error_code === "string" ? reply.error_code.toLowerCase() : "";
  if (code === "busy" || code === "cancelled" || code === "not_running") {
    return false;
  }
  return reply.accepted === true || reply.running === true;
}

/**
 * Promote pending → active only on successful admission.
 * Rejected second train preserves the authoritative active id.
 */
export function commitJobOnAdmission(
  book: JobIdBook,
  reply: {
    accepted?: boolean;
    running?: boolean;
    busy?: boolean;
    error_code?: string | null;
  },
): JobIdBook {
  const pending = book.pendingJobId;
  if (!pending) {
    return book;
  }
  if (isTrainAdmissionSuccess(reply)) {
    return { activeJobId: pending, pendingJobId: null };
  }
  // Rejection: drop pending; keep prior active for default Stop.
  return { activeJobId: book.activeJobId, pendingJobId: null };
}

/** Default Stop/Pause target — authoritative active only, never pending. */
export function defaultStopJobId(book: JobIdBook): string | null {
  return book.activeJobId;
}

export type CancelAckKind =
  | "cancelled"
  | "noop_not_running"
  | "rejected";

export interface CancelAck {
  kind: CancelAckKind;
  /**
   * When host says not_running during Build→Train handoff, client latch still
   * cancelled the composite intent — UI should treat as acknowledged noop.
   */
  duringBuildHandoff: boolean;
  reason?: string;
}

export function interpretCancelReply(
  reply: { cancelled?: boolean; reason?: string | null },
  intent: CompositeSolveIntent | null,
): CancelAck {
  const reason =
    typeof reply.reason === "string" && reply.reason.trim()
      ? reply.reason.trim()
      : undefined;
  const duringBuildHandoff = intent != null && stopAppliesDuringBuild(intent);
  if (reply.cancelled === true) {
    return { kind: "cancelled", duringBuildHandoff: false, reason };
  }
  if (reason === "not_running" || reply.cancelled === false) {
    return {
      kind: "noop_not_running",
      duringBuildHandoff,
      reason: reason ?? "not_running",
    };
  }
  return {
    kind: "rejected",
    duringBuildHandoff: false,
    reason: reason ?? "cancel_rejected",
  };
}

/** Job-local fields that must clear on successful Open / solution replacement. */
export const JOB_LOCAL_STATUS_KEYS = [
  "iterations_requested",
  "job_id",
  "running",
  "paused",
  "cancelled",
  "failed",
  "last_error",
  "error",
  "time_limit_reached",
  "message",
] as const;

export type JobLocalStatusKey = (typeof JOB_LOCAL_STATUS_KEYS)[number];

/**
 * Checkpoint / disk metadata that Open must preserve when resetting job-local
 * targets (iterations already on disk, solution identity, strategy revision).
 */
export const CHECKPOINT_STATUS_KEYS = [
  "iterations",
  "solution_id",
  "baseline_solution_id",
  "root_node_id",
  "policy_revision",
  "analysis_revision",
  "pot",
  "stack",
  "board",
  "algorithm",
  "frozen",
  "has_training",
  "can_continue",
  "nash_gap",
  "accuracy_chips",
  "player0_expected_utility",
  "value",
  "samples",
  "gap_series",
  "engine_allocated",
  "engine_peak",
  "engine_heap_bytes",
] as const;

export type CheckpointStatusKey = (typeof CHECKPOINT_STATUS_KEYS)[number];

export interface OpenJobLocalReset {
  /** Cleared / neutralized job-local targets and terminal errors. */
  jobLocal: {
    iterations_requested: null;
    job_id: null;
    running: false;
    paused: false;
    cancelled: false;
    failed: false;
    last_error: null;
    error: null;
    time_limit_reached: false;
    message: null;
  };
  /** Job id book after a successful replacement. */
  jobIds: JobIdBook;
  /** Composite intent cleared — Open is not a solve handoff. */
  intent: null;
}

/**
 * After a successful Open / solution replacement: reset job-local targets and
 * terminal errors. Callers merge `jobLocal` onto status while keeping checkpoint
 * metadata keys from the loaded file / host status.
 */
export function resetJobLocalOnOpenSuccess(): OpenJobLocalReset {
  return {
    jobLocal: {
      iterations_requested: null,
      job_id: null,
      running: false,
      paused: false,
      cancelled: false,
      failed: false,
      last_error: null,
      error: null,
      time_limit_reached: false,
      message: null,
    },
    jobIds: emptyJobIdBook(),
    intent: null,
  };
}

/**
 * Merge host/open status with job-local reset: preserve checkpoint metadata
 * fields present on `status`, force job-local clears.
 */
export function applyOpenJobLocalReset<T extends Record<string, unknown>>(
  status: T,
): T & OpenJobLocalReset["jobLocal"] {
  const reset = resetJobLocalOnOpenSuccess().jobLocal;
  const next: Record<string, unknown> = { ...status, ...reset };
  return next as T & OpenJobLocalReset["jobLocal"];
}

export type TrainWireKind = "solve" | "continue" | "resolve_locked";

export interface TrainWireInput {
  iterations: number;
  /** When the UI exposes Samples (Settings / Resolve), forward on the wire. */
  samples?: number | null;
  accuracy?: number | null;
  time_limit?: number | null;
  eval_every?: number | null;
  /** resolve_locked only. */
  warm_start?: number | boolean | null;
}

/**
 * Build the train / resolve_locked request body.
 * Includes `samples` alongside `iterations` whenever the UI supplied a finite
 * positive Samples value (Solve, Continue, or Resolve per exposed options).
 */
export function buildTrainRequestBody(
  kind: TrainWireKind,
  input: TrainWireInput,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    iterations: Math.max(1, Math.trunc(input.iterations || 1)),
  };
  if (kind === "resolve_locked") {
    body.warm_start = input.warm_start ? 1 : 0;
  }
  if (
    typeof input.accuracy === "number" &&
    Number.isFinite(input.accuracy) &&
    input.accuracy > 0
  ) {
    body.accuracy = input.accuracy;
  }
  if (
    typeof input.time_limit === "number" &&
    Number.isFinite(input.time_limit) &&
    input.time_limit >= 0
  ) {
    body.time_limit = input.time_limit;
  }
  if (
    typeof input.eval_every === "number" &&
    Number.isFinite(input.eval_every) &&
    input.eval_every > 0
  ) {
    body.eval_every = Math.trunc(input.eval_every);
  }
  if (
    typeof input.samples === "number" &&
    Number.isFinite(input.samples) &&
    input.samples > 0
  ) {
    body.samples = Math.trunc(input.samples);
  }
  return body;
}

/**
 * Capture identity scopes from mixed status / equity payloads with explicit
 * field names so later wire-up cannot conflate status sequence with equity gen.
 */
export function captureStudyIdentityScopes(args: {
  launchId?: string | null;
  policyRevision?: number | null;
  /** Prefer an explicitly named status sequence; falls back to status_generation. */
  statusSequence?: number | null;
  status_generation?: number | null;
  /** Equity-only generation — pass separately; never copy statusSequence here. */
  equityGeneration?: number | null;
}): StudyIdentityScopes {
  const statusSequence =
    typeof args.statusSequence === "number" && Number.isFinite(args.statusSequence)
      ? args.statusSequence
      : typeof args.status_generation === "number" &&
          Number.isFinite(args.status_generation)
        ? args.status_generation
        : null;
  return {
    launchId:
      typeof args.launchId === "string" && args.launchId.trim()
        ? args.launchId.trim()
        : null,
    policyRevision:
      typeof args.policyRevision === "number" && Number.isFinite(args.policyRevision)
        ? args.policyRevision
        : null,
    statusSequence,
    equityGeneration:
      typeof args.equityGeneration === "number" &&
      Number.isFinite(args.equityGeneration)
        ? args.equityGeneration
        : null,
  };
}
