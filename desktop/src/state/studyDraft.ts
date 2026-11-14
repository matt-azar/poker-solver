/** Pure draft/job conversion helpers for the Study store (no module mutables). */
import {
  encodeBettingJob,
  formatDonkField,
  formatStoredSizes,
  formatStreetBetField,
  formatStreetRaiseField,
} from "../domain/betSizes";
import { boardCards, parseAbsoluteNumberList } from "../domain/range";
import {
  formatEdgeTagsDraft,
  formatIncentivesDraft,
} from "../domain/setup/templateApply";
import {
  type SolveJobRequest,
  type SolvePhase,
  type SpotDraft,
  type StatusPayload,
} from "../domain/types";

export function joinSizes(values: unknown): string {
  return formatStoredSizes(values);
}

/** Rebuild a Build raise field from pot fractions + facing multiples. */
export function joinRaiseDraft(fractions: unknown, multiples: unknown): string {
  const base = formatStoredSizes(fractions, { raise: true });
  const extra: string[] = [];
  if (Array.isArray(multiples)) {
    for (const value of multiples) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) {
        extra.push(`${n}x`);
      }
    }
  }
  if (base === "-") {
    return extra.length > 0 ? extra.join(", ") : "-";
  }
  return [base, ...extra].filter(Boolean).join(", ");
}

export { formatEdgeTagsDraft, formatIncentivesDraft };

function finiteOrZero(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Map POST /api/config JSON onto a SpotDraft patch.
 * Preserves explicit zeros (rake_rate 0, pot_cap 0, …). Callers that load a
 * full template must merge onto a cleared base — see draftFromFullTemplate.
 */
export function draftFromParsedConfig(body: Record<string, unknown>): Partial<SpotDraft> {
  const board = Array.isArray(body.board)
    ? body.board.map((card) => String(card)).join(" ")
    : "";
  const partial: Partial<SpotDraft> = {
    boardText: board,
    pot: finiteOrZero(body.pot),
    stack: finiteOrZero(body.stack),
    maxRaises: finiteOrZero(body.max_raises),
    oopBets: joinSizes(body.oop_bets),
    ipBets: joinSizes(body.ip_bets),
    oopRaises: joinRaiseDraft(body.oop_raises, body.oop_raise_multiples),
    ipRaises: joinRaiseDraft(body.ip_raises, body.ip_raise_multiples),
  };
  if (body.kind === "street") {
    partial.oopFlop = formatStreetBetField(body.oop_flop_bets, body.oop_bets);
    partial.ipFlop = formatStreetBetField(body.ip_flop_bets, body.ip_bets);
    partial.oopTurn = formatStreetBetField(body.oop_turn_bets, body.oop_bets);
    partial.ipTurn = formatStreetBetField(body.ip_turn_bets, body.ip_bets);
    partial.oopRiver = formatStreetBetField(body.oop_river_bets, body.oop_bets);
    partial.ipRiver = formatStreetBetField(body.ip_river_bets, body.ip_bets);
    partial.oopFlopRaises = formatStreetRaiseField(
      body.oop_flop_raises,
      body.oop_raises,
      body.oop_flop_bets,
      { sharedBets: body.oop_bets },
    );
    partial.ipFlopRaises = formatStreetRaiseField(
      body.ip_flop_raises,
      body.ip_raises,
      body.ip_flop_bets,
      { sharedBets: body.ip_bets },
    );
    partial.oopTurnRaises = formatStreetRaiseField(
      body.oop_turn_raises,
      body.oop_raises,
      body.oop_turn_bets,
      { sharedBets: body.oop_bets },
    );
    partial.ipTurnRaises = formatStreetRaiseField(
      body.ip_turn_raises,
      body.ip_raises,
      body.ip_turn_bets,
      { sharedBets: body.ip_bets },
    );
    partial.oopRiverRaises = formatStreetRaiseField(
      body.oop_river_raises,
      body.oop_raises,
      body.oop_river_bets,
      { sharedBets: body.oop_bets },
    );
    partial.ipRiverRaises = formatStreetRaiseField(
      body.ip_river_raises,
      body.ip_raises,
      body.ip_river_bets,
      { sharedBets: body.ip_bets },
    );
    partial.oopDonk = joinSizes(body.oop_donk);
    const flopDonk = formatDonkField(
      body.oop_flop_donk,
      body.oop_flop_bets ?? body.oop_bets,
      body.oop_donk,
    );
    partial.oopFlopDonk = flopDonk.text;
    partial.donkFlop = flopDonk.copyBets;
    const turnDonk = formatDonkField(
      body.oop_turn_donk,
      body.oop_turn_bets ?? body.oop_bets,
      body.oop_donk,
    );
    partial.oopTurnDonk = turnDonk.text;
    partial.donkTurn = turnDonk.copyBets;
    const riverDonk = formatDonkField(
      body.oop_river_donk,
      body.oop_river_bets ?? body.oop_bets,
      body.oop_donk,
    );
    partial.oopRiverDonk = riverDonk.text;
    partial.donkRiver = riverDonk.copyBets;
    if (body.merge_threshold != null) {
      partial.mergeThresholdPct = Number(body.merge_threshold) * 100;
    }
    // Preserve explicit zeros (pot_cap 0, all_in_threshold 0).
    if ("pot_cap" in body) {
      partial.potCap = finiteOrZero(body.pot_cap);
    }
    partial.noThreeBet = body.allow_three_bet === false;
    if ("all_in_threshold" in body) {
      partial.allInThreshold = finiteOrZero(body.all_in_threshold);
    }
    if ("memory_mib" in body) {
      partial.memoryMib = finiteOrZero(body.memory_mib);
    }
    if ("threads" in body) {
      const threads = finiteOrZero(body.threads);
      partial.threads = threads > 0 ? threads : 1;
    }
    if (Array.isArray(body.tree_edits)) {
      partial.treeEdits = body.tree_edits.map((line) => String(line)).filter(Boolean);
    }
  }

  // Engine solve rake — preserve explicit 0 (bundled templates set rake-rate 0).
  if ("rake_rate" in body) {
    partial.rakeRate = finiteOrZero(body.rake_rate);
  }
  if ("rake_cap" in body) {
    partial.rakeCap = finiteOrZero(body.rake_cap);
  }

  if ("icm_stacks" in body) {
    if (Array.isArray(body.icm_stacks)) {
      const stacks = body.icm_stacks
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value));
      if (stacks.length >= 2) {
        partial.useIcm = true;
        partial.icmStacks = stacks.join(", ");
        partial.icmPayouts = Array.isArray(body.icm_payouts)
          ? body.icm_payouts
              .map((value) => Number(value))
              .filter((value) => Number.isFinite(value))
              .join(", ")
          : "";
      } else {
        partial.useIcm = false;
        partial.icmStacks = "";
        partial.icmPayouts = "";
      }
    } else {
      partial.useIcm = false;
      partial.icmStacks = "";
      partial.icmPayouts = "";
    }
  }

  if ("incentives" in body) {
    partial.incentives = formatIncentivesDraft(body.incentives);
  }
  if ("edge_tags" in body) {
    partial.edgeTags = formatEdgeTagsDraft(body.edge_tags);
  }
  if ("time_limit" in body) {
    const timeLimit = Number(body.time_limit);
    partial.timeLimit =
      Number.isFinite(timeLimit) && timeLimit >= 0 ? String(timeLimit) : "";
  }

  return partial;
}

export function phaseFromStatus(status: StatusPayload | null, fallback: SolvePhase): SolvePhase {
  if (!status) {
    return fallback;
  }
  const hostPhase =
    typeof status.phase === "string" ? status.phase.toLowerCase() : "";
  // Host publishes phase:"failed"; also honor sticky last_error / legacy error (ZR-123 / ZR-130).
  const stickyError =
    (typeof status.last_error === "string" && status.last_error.length > 0) ||
    Boolean(status.error);
  if (status.failed || stickyError || hostPhase === "failed") {
    return "failed";
  }
  // Host begin_config compile (ZR-120): Building until train admits.
  if (hostPhase === "compiling") {
    return "building";
  }
  if (status.running && status.paused) {
    return "pause_requested";
  }
  if (status.running || hostPhase === "training") {
    // Keep local Pausing/Stopping chrome while the host is still running
    // (poll must not wipe pause_requested / stop_requested back to Solving).
    if (fallback === "pause_requested" || fallback === "stop_requested") {
      return fallback;
    }
    return "solving";
  }
  if (status.paused || hostPhase === "paused") {
    return "paused";
  }
  if (status.solution_id || hostPhase === "published") {
    return "complete";
  }
  // Clear sticky busy/cancel when the host is idle (no solution / not running).
  if (
    fallback === "solving" ||
    fallback === "pause_requested" ||
    fallback === "stop_requested" ||
    fallback === "building"
  ) {
    return "idle";
  }
  return fallback;
}

export function rootNodeId(statusRoot?: string | null): string {
  return statusRoot || "p0.t-1.r-1";
}

export function buildJob(draft: SpotDraft): SolveJobRequest {
  const board = boardCards(draft.boardText);
  const sizes = encodeBettingJob(draft);

  const icmStacks = draft.useIcm ? parseAbsoluteNumberList(draft.icmStacks) : [];
  const icmPayouts = draft.useIcm ? parseAbsoluteNumberList(draft.icmPayouts) : [];
  if (draft.useIcm && icmStacks.length < 2) {
    throw new Error("ICM stacks need at least two seats.");
  }

  const body: SolveJobRequest = {
    board,
    oop_range: draft.oopRange,
    ip_range: draft.ipRange,
    pot: draft.pot,
    stack: draft.stack,
    ...sizes,
    pot_cap: draft.potCap || 0,
    allow_three_bet: draft.noThreeBet ? 0 : 1,
    // Pio fraction of starting stack; default 0.5. List `a` for explicit all-in.
    all_in_threshold:
      Number.isFinite(draft.allInThreshold) ? draft.allInThreshold : 0.5,
    // Desktop always uses the frozen pass (required for multi-thread / CFR+).
    frozen: 1,
    accuracy: draft.accuracy.trim() === "" ? -1 : Number(draft.accuracy),
    max_raises: draft.maxRaises,
    iterations: draft.iterations,
    memory_mib: draft.memoryMib,
    threads: draft.threads,
    algorithm: draft.algorithm,
    samples: Math.max(1, Math.min(20, draft.samples || 5)),
    // Engine solve rake (independent of range-source / catalogue stakesLabel).
    rake_rate: draft.rakeRate || 0,
    rake_cap: draft.rakeCap || 0,
    icm_stacks: icmStacks,
    icm_payouts: icmPayouts,
    incentives: parseIncentiveRules(draft.incentives),
    edge_tags: parseEdgeTagSpecs(draft.edgeTags),
  };
  if (draft.timeLimit.trim() !== "") {
    body.time_limit = Number(draft.timeLimit);
  }
  if (draft.treeEdits.length > 0) {
    body.tree_edits = [...draft.treeEdits];
  }
  return body;
}

export function parseIncentiveRules(text: string): SolveJobRequest["incentives"] {
  return String(text || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((line) => {
      const tokens = line.split(/[\s,]+/).filter(Boolean);
      if (tokens.length !== 4) {
        throw new Error("Incentive needs kind, player, key, and delta.");
      }
      const kind = tokens[0];
      if (kind !== "label" && kind !== "tag") {
        throw new Error("Incentive kind must be label or tag.");
      }
      return {
        kind,
        player: Number(tokens[1]),
        key: tokens[2],
        delta: Number(tokens[3]),
      };
    });
}

export function parseEdgeTagSpecs(text: string): SolveJobRequest["edge_tags"] {
  return String(text || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((line) => {
      const tokens = line.split(/[\s,]+/).filter(Boolean);
      if (tokens.length < 2) {
        throw new Error("Edge tag needs an action and a tag.");
      }
      let player = -1;
      let actionAt = 0;
      if ((tokens[0] === "0" || tokens[0] === "1") && tokens.length >= 3) {
        player = Number(tokens[0]);
        actionAt = 1;
      }
      return {
        player,
        action: tokens[actionAt],
        tags: tokens.slice(actionAt + 1),
      };
    });
}
