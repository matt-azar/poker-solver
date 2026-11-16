/**
 * Build ↔ portable study job serialization.
 * Canonical street-config comes from formatSolveJobStreetConfig(buildJob(draft)).
 */
import { formatSolveJobStreetConfig, parseStreetConfigTextToSolutionConfig } from "../../engine/streetConfigText";
import {
  accuracyEngineToField,
  buildJob,
  draftFromParsedConfig,
} from "../../state/studyDraft";
import { DEFAULT_SPOT, type SolveJobRequest, type SpotDraft } from "../types";
import { assertJobRepresentableInBuild } from "./representability";
import {
  STUDY_JOB_SCHEMA,
  type StudyJob,
  type StudyJobDecision,
  type StudyJobProvenance,
  type StudyJobReview,
  type StudyJobRunLimits,
  isStudyJob,
} from "./types";

export interface PortableJobFromDraftOptions {
  provenance?: Partial<StudyJobProvenance>;
  review?: StudyJobReview;
  decision?: StudyJobDecision;
  /** Override run limits; default from draft iterations / accuracy / timeLimit. */
  run?: Partial<StudyJobRunLimits>;
}

function normalizeStreetConfig(text: string): string {
  const trimmed = text.replace(/\r\n/g, "\n").trimEnd();
  return trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
}

export function runLimitsFromDraft(draft: SpotDraft): StudyJobRunLimits {
  const job = buildJob(draft);
  const run: StudyJobRunLimits = {
    iterations: Math.max(1, Math.trunc(job.iterations || 1)),
  };
  if (typeof job.accuracy === "number" && Number.isFinite(job.accuracy) && job.accuracy >= 0) {
    run.accuracy = job.accuracy;
  } else {
    run.accuracy = null;
  }
  if (typeof job.time_limit === "number" && Number.isFinite(job.time_limit) && job.time_limit > 0) {
    run.time_limit = job.time_limit;
  } else {
    run.time_limit = null;
  }
  return run;
}

/** Same SolveJobRequest Build → Solve / Preview uses. */
export function solveJobFromDraft(draft: SpotDraft): SolveJobRequest {
  return buildJob(draft);
}

/**
 * Emit a portable job from the current Build draft.
 * street_config matches host begin_config / tree_preview input.
 */
export function portableJobFromDraft(
  draft: SpotDraft,
  options: PortableJobFromDraftOptions = {},
): StudyJob {
  const solveJob = buildJob(draft);
  const street_config = normalizeStreetConfig(formatSolveJobStreetConfig(solveJob));
  const baseRun = runLimitsFromDraft(draft);
  const run: StudyJobRunLimits = {
    iterations: Math.max(1, Math.trunc(options.run?.iterations ?? baseRun.iterations)),
    accuracy:
      options.run && "accuracy" in options.run
        ? options.run.accuracy ?? null
        : baseRun.accuracy ?? null,
    time_limit:
      options.run && "time_limit" in options.run
        ? options.run.time_limit ?? null
        : baseRun.time_limit ?? null,
  };
  if (!Number.isFinite(run.iterations) || run.iterations < 1) {
    throw new Error("run.iterations must be a positive integer");
  }
  const provenance: StudyJobProvenance = {
    source: options.provenance?.source ?? "build",
    created_at: options.provenance?.created_at ?? new Date().toISOString(),
    created_by: options.provenance?.created_by ?? "holdem-study",
    ...options.provenance,
  };
  const job: StudyJob = {
    schema: STUDY_JOB_SCHEMA,
    street_config,
    run,
    provenance,
  };
  if (options.review) job.review = options.review;
  if (options.decision) job.decision = options.decision;
  return job;
}

export function parsePortableJobJson(text: string): StudyJob {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `invalid study job JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isStudyJob(parsed)) {
    throw new Error("invalid study job: expected schema holdem-study-job/1 with street_config and run.iterations");
  }
  const street = normalizeStreetConfig(parsed.street_config);
  if (!street.startsWith("street-config 1")) {
    throw new Error("invalid study job: street_config must start with street-config 1");
  }
  const iterations = Math.trunc(parsed.run.iterations);
  if (!Number.isFinite(iterations) || iterations < 1) {
    throw new Error("invalid study job: run.iterations must be ≥ 1");
  }
  return {
    ...parsed,
    street_config: street,
    run: {
      iterations,
      accuracy:
        typeof parsed.run.accuracy === "number" && Number.isFinite(parsed.run.accuracy)
          ? parsed.run.accuracy
          : parsed.run.accuracy === null
            ? null
            : undefined,
      time_limit:
        typeof parsed.run.time_limit === "number" && Number.isFinite(parsed.run.time_limit)
          ? parsed.run.time_limit
          : parsed.run.time_limit === null
            ? null
            : undefined,
    },
  };
}

export function stringifyPortableJob(job: StudyJob, space = 2): string {
  return `${JSON.stringify(job, null, space)}\n`;
}

/**
 * Apply a portable job onto a fresh SpotDraft (Build load path).
 * Run limits overwrite draft iterations / accuracy / timeLimit.
 */
export function draftFromPortableJob(job: StudyJob): {
  draft: SpotDraft;
  warnings: string[];
} {
  const parsed = parsePortableJobJson(stringifyPortableJob(job));
  assertJobRepresentableInBuild(parsed);
  const config = parseStreetConfigTextToSolutionConfig(parsed.street_config);
  const partial = draftFromParsedConfig(config);
  const draft: SpotDraft = {
    ...DEFAULT_SPOT,
    ...partial,
    iterations: parsed.run.iterations,
    accuracy:
      typeof parsed.run.accuracy === "number" && parsed.run.accuracy >= 0
        ? accuracyEngineToField(parsed.run.accuracy)
        : "",
    timeLimit:
      typeof parsed.run.time_limit === "number" && parsed.run.time_limit > 0
        ? String(parsed.run.time_limit)
        : "",
  };
  const warnings: string[] = [];
  if (parsed.review?.missing_sizes?.length) {
    warnings.push(
      `Played sizes missing from tree: ${parsed.review.missing_sizes.join(", ")}`,
    );
  }
  if (parsed.review?.warnings?.length) {
    warnings.push(...parsed.review.warnings);
  }
  return { draft, warnings };
}

/** Solve args the CLI / EngineClient send after begin_config. */
export function solveArgsFromJob(job: StudyJob): {
  iterations: number;
  accuracy?: number;
  time_limit?: number;
} {
  const iterations = Math.max(1, Math.trunc(job.run.iterations));
  const out: { iterations: number; accuracy?: number; time_limit?: number } = {
    iterations,
  };
  if (typeof job.run.accuracy === "number" && Number.isFinite(job.run.accuracy) && job.run.accuracy >= 0) {
    out.accuracy = job.run.accuracy;
  }
  if (
    typeof job.run.time_limit === "number" &&
    Number.isFinite(job.run.time_limit) &&
    job.run.time_limit > 0
  ) {
    out.time_limit = job.run.time_limit;
  }
  return out;
}
