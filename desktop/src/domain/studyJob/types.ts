/**
 * Portable holdem-study-job/1 — street-config 1 + run limits + provenance.
 * Build and holdem-study-cli consume the same JSON; assistant intent is
 * resolved into ranges/pot/stack/sizing before this document is emitted.
 */

export const STUDY_JOB_SCHEMA = "holdem-study-job/1" as const;

export interface StudyJobRunLimits {
  /** CFR+ iterations (required, ≥1). */
  iterations: number;
  /**
   * Pio Accuracy stop as pot fraction (NashConv/2 / pot).
   * Negative or omitted → iteration/time only.
   */
  accuracy?: number | null;
  /** Wall-clock seconds; null/omit → no time stop. */
  time_limit?: number | null;
}

export interface StudyJobProvenance {
  source: string;
  created_at?: string;
  created_by?: string;
  notes?: string;
  /** Chart / hole / label provenance for each seat. */
  range_sources?: {
    oop?: string;
    ip?: string;
  };
  hand_history?: string;
  [key: string]: unknown;
}

export interface StudyJobPositions {
  oop?: string;
  ip?: string;
}

export interface StudyJobReview {
  positions?: StudyJobPositions;
  board: string[];
  pot: number;
  effective_stack: number;
  /** Canonical engine labels along the played line from street start. */
  action_line: string[];
  range_sources?: {
    oop?: string;
    ip?: string;
  };
  /** Played Bet/Raise sizes absent from the configured tree. */
  missing_sizes: string[];
  /** Supported street boundary for this job (`river` for v1). */
  street_boundary: "river";
  warnings?: string[];
}

export interface StudyJobDecision {
  /**
   * Recorded actions from the street-root to the Study decision node
   * (must land on a decision — not a terminal after Call/Fold).
   */
  actions: string[];
  /** Slash-joined engine labels for the same path (optional mirror). */
  path?: string;
}

export interface StudyJob {
  schema: typeof STUDY_JOB_SCHEMA;
  /** Full `street-config 1` document (LF endings preferred). */
  street_config: string;
  run: StudyJobRunLimits;
  provenance: StudyJobProvenance;
  review?: StudyJobReview;
  decision?: StudyJobDecision;
}

export function isStudyJob(value: unknown): value is StudyJob {
  if (!value || typeof value !== "object") return false;
  const job = value as Record<string, unknown>;
  if (job.schema !== STUDY_JOB_SCHEMA) return false;
  if (typeof job.street_config !== "string" || !job.street_config.trim()) {
    return false;
  }
  const run = job.run as Record<string, unknown> | undefined;
  if (!run || typeof run.iterations !== "number" || !Number.isFinite(run.iterations)) {
    return false;
  }
  if (!job.provenance || typeof job.provenance !== "object") return false;
  return true;
}
