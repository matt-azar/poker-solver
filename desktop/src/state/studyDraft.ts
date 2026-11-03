/** Pure draft/job conversion helpers for the Study store (no module mutables). */
import { encodeBettingJob, formatStoredSizes } from "../domain/betSizes";
import { boardCards, parseAbsoluteNumberList } from "../domain/range";
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

export function draftFromParsedConfig(body: Record<string, unknown>): Partial<SpotDraft> {
  const board = Array.isArray(body.board)
    ? body.board.map((card) => String(card)).join(" ")
    : "";
  const partial: Partial<SpotDraft> = {
    boardText: board,
    pot: Number(body.pot) || 0,
    stack: Number(body.stack) || 0,
    maxRaises: Number(body.max_raises) || 0,
    allowAllIn: Boolean(body.allow_all_in),
    oopBets: joinSizes(body.oop_bets),
    ipBets: joinSizes(body.ip_bets),
    oopRaises: joinRaiseDraft(body.oop_raises, body.oop_raise_multiples),
    ipRaises: joinRaiseDraft(body.ip_raises, body.ip_raise_multiples),
  };
  if (body.kind === "street") {
    partial.oopFlop = joinSizes(body.oop_flop_bets);
    partial.ipFlop = joinSizes(body.ip_flop_bets);
    partial.oopTurn = joinSizes(body.oop_turn_bets);
    partial.ipTurn = joinSizes(body.ip_turn_bets);
    partial.oopRiver = joinSizes(body.oop_river_bets);
    partial.ipRiver = joinSizes(body.ip_river_bets);
    partial.oopFlopRaises = formatStoredSizes(body.oop_flop_raises, {
      raise: true,
      matchBets: body.oop_flop_bets,
    });
    partial.ipFlopRaises = formatStoredSizes(body.ip_flop_raises, {
      raise: true,
      matchBets: body.ip_flop_bets,
    });
    partial.oopTurnRaises = formatStoredSizes(body.oop_turn_raises, {
      raise: true,
      matchBets: body.oop_turn_bets,
    });
    partial.ipTurnRaises = formatStoredSizes(body.ip_turn_raises, {
      raise: true,
      matchBets: body.ip_turn_bets,
    });
    partial.oopRiverRaises = formatStoredSizes(body.oop_river_raises, {
      raise: true,
      matchBets: body.oop_river_bets,
    });
    partial.ipRiverRaises = formatStoredSizes(body.ip_river_raises, {
      raise: true,
      matchBets: body.ip_river_bets,
    });
    partial.oopDonk = joinSizes(body.oop_donk);
    partial.oopFlopDonk = joinSizes(body.oop_flop_donk);
    partial.oopTurnDonk = joinSizes(body.oop_turn_donk);
    partial.oopRiverDonk = joinSizes(body.oop_river_donk);
    if (body.merge_threshold != null) {
      partial.mergeThresholdPct = Number(body.merge_threshold) * 100;
    }
    partial.potCap = Number(body.pot_cap) || 0;
    partial.noThreeBet = body.allow_three_bet === false;
    partial.geometric = Boolean(body.geometric);
    partial.allInThreshold = Number(body.all_in_threshold) || 0;
    partial.memoryMib = Number(body.memory_mib) || 0;
    partial.threads = Number(body.threads) || 1;
    if (Array.isArray(body.tree_edits)) {
      partial.treeEdits = body.tree_edits.map((line) => String(line)).filter(Boolean);
    }
  }
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
  }
  return partial;
}

export function phaseFromStatus(status: StatusPayload | null, fallback: SolvePhase): SolvePhase {
  if (!status) {
    return fallback;
  }
  if (status.failed || status.error) {
    return "failed";
  }
  if (status.running && status.paused) {
    return "pause_requested";
  }
  if (status.running) {
    return "solving";
  }
  if (status.paused) {
    return "paused";
  }
  if (status.solution_id) {
    return "complete";
  }
  return fallback === "solving" || fallback === "pause_requested" ? "idle" : fallback;
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
    all_in_threshold: draft.allInThreshold || 0,
    allow_all_in: draft.allowAllIn ? 1 : 0,
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
