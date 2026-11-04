/**
 * Full-template application: convert a parsed street/river config into a
 * complete SpotDraft. Unlike a partial merge, absent utility fields reset to
 * the blank-spot defaults so a prior rake/ICM/incentive setup cannot leak.
 *
 * Range-source catalogue labels (e.g. 100NL) are independent of solve rake and
 * are not written here.
 */
import { DEFAULT_SPOT, type SpotDraft } from "../types";
import { draftPartialFromSolutionConfig, openDraftBase } from "./identity";

export interface FullTemplateOptions {
  /** Preserve the current document save path (templates are not solutions). */
  solutionPath?: string;
  /**
   * Keep current solve-session fields the config format does not carry
   * (iterations / algorithm / samples / accuracy). Defaults to DEFAULT_SPOT.
   */
  preserveSolveSession?: Pick<
    SpotDraft,
    "iterations" | "algorithm" | "samples" | "accuracy" | "frozen"
  >;
}

/** Serialize config-parse `incentives` JSON into Build draft text. */
export function formatIncentivesDraft(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  const parts: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const row = entry as Record<string, unknown>;
    const kind = String(row.kind ?? "").trim();
    if (kind !== "label" && kind !== "tag") {
      continue;
    }
    const player = Number(row.player);
    const key = String(row.key ?? "").trim();
    const delta = Number(row.delta);
    if (!Number.isFinite(player) || !key || !Number.isFinite(delta)) {
      continue;
    }
    parts.push(`${kind} ${player} ${key} ${delta}`);
  }
  return parts.join("; ");
}

/** Serialize config-parse `edge_tags` JSON into Build draft text. */
export function formatEdgeTagsDraft(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  const parts: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const row = entry as Record<string, unknown>;
    const action = String(row.action ?? row.key ?? "").trim();
    if (!action) {
      continue;
    }
    const tags = Array.isArray(row.tags)
      ? row.tags.map((tag) => String(tag).trim()).filter(Boolean)
      : [];
    if (tags.length === 0) {
      continue;
    }
    const player = Number(row.player);
    if (Number.isFinite(player) && player >= 0) {
      parts.push(`${player} ${action} ${tags.join(" ")}`);
    } else {
      parts.push(`${action} ${tags.join(" ")}`);
    }
  }
  return parts.join("; ");
}

/**
 * Blank utility + betting base for a full template load.
 * Explicit zeros from the parsed config overwrite these via the config mapper.
 */
export function templateDraftBase(options: FullTemplateOptions = {}): SpotDraft {
  const session = options.preserveSolveSession;
  const base = openDraftBase(options.solutionPath ?? "");
  return {
    ...base,
    // openDraftBase already clears utility; reaffirm rake zeros for the contract.
    rakeRate: 0,
    rakeCap: 0,
    accuracy: session?.accuracy ?? "",
    iterations: session?.iterations ?? DEFAULT_SPOT.iterations,
    algorithm: session?.algorithm ?? DEFAULT_SPOT.algorithm,
    samples: session?.samples ?? DEFAULT_SPOT.samples,
    frozen: session?.frozen ?? DEFAULT_SPOT.frozen,
  };
}

/**
 * Complete setup transaction for a bundled/full template.
 * Starts from a cleared base, applies every supported parsed field
 * (preserving explicit 0 / false / empty), and sets ranges from the config.
 */
export function draftFromFullTemplate(
  body: Record<string, unknown>,
  options: FullTemplateOptions = {},
): SpotDraft {
  const base = templateDraftBase(options);
  const partial = draftPartialFromSolutionConfig(body);
  const oopRange = typeof body.oop_range === "string" ? body.oop_range : "";
  const ipRange = typeof body.ip_range === "string" ? body.ip_range : "";

  const utility: Partial<SpotDraft> = {};

  // Rake: preserve explicit zeros; absent keys reset to 0 (already on base).
  if ("rake_rate" in body) {
    const n = Number(body.rake_rate);
    utility.rakeRate = Number.isFinite(n) ? n : 0;
  } else {
    utility.rakeRate = 0;
  }
  if ("rake_cap" in body) {
    const n = Number(body.rake_cap);
    utility.rakeCap = Number.isFinite(n) ? n : 0;
  } else {
    utility.rakeCap = 0;
  }

  if ("incentives" in body) {
    utility.incentives = formatIncentivesDraft(body.incentives);
  } else {
    utility.incentives = "";
  }
  if ("edge_tags" in body) {
    utility.edgeTags = formatEdgeTagsDraft(body.edge_tags);
  } else {
    utility.edgeTags = "";
  }

  if (!("icm_stacks" in body)) {
    utility.useIcm = false;
    utility.icmStacks = "";
    utility.icmPayouts = "";
  }

  if ("time_limit" in body) {
    const timeLimit = Number(body.time_limit);
    utility.timeLimit =
      Number.isFinite(timeLimit) && timeLimit >= 0 ? String(timeLimit) : "";
  } else {
    utility.timeLimit = "";
  }

  return {
    ...base,
    ...partial,
    ...utility,
    oopRange,
    ipRange,
    solutionPath: options.solutionPath ?? base.solutionPath,
  };
}
