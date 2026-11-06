import { serializeExactRange, type ExactRange } from "../range";
import type { NodePayload } from "../types";
import { createDefaultEquityDraft, type EquityScenarioDraft } from "./types";

/** Copy Build draft ranges + board into an Equity calculator scenario. */
export function draftFromBuild(input: {
  oopRange: string;
  ipRange: string;
  boardText: string;
  oopLabel?: string;
  ipLabel?: string;
}): EquityScenarioDraft {
  const board = input.boardText
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  const draft = createDefaultEquityDraft();
  draft.name = "From Build";
  draft.board = board;
  draft.players[0] = {
    id: "p1",
    label: input.oopLabel ?? "OOP",
    enabled: true,
    rangeText: input.oopRange,
  };
  draft.players[1] = {
    id: "p2",
    label: input.ipLabel ?? "IP",
    enabled: true,
    rangeText: input.ipRange,
  };
  draft.selectedPlayerId = "p1";
  return draft;
}

function rangeFromReach(combos: string[] | undefined, reach: number[] | undefined): string {
  if (!combos || !reach || combos.length !== reach.length) {
    return "";
  }
  const exact: ExactRange = new Map();
  for (let i = 0; i < combos.length; i++) {
    const weight = reach[i]!;
    if (!(weight > 0) || !Number.isFinite(weight)) {
      continue;
    }
    exact.set(combos[i]!, weight);
  }
  return serializeExactRange(exact);
}

export type StudyTransferResult =
  | { ok: true; draft: EquityScenarioDraft }
  | { ok: false; reason: string };

/**
 * Copy strategy-conditioned reaching ranges from a Study node.
 * Uses reach / opponent_reach (not posterior marginals).
 */
export function draftFromStudyNode(input: {
  node: NodePayload;
  solutionId: string;
}): StudyTransferResult {
  const node = input.node;
  const heroCombos = node.combos;
  const heroReach = node.reach;
  const villainCombos = node.opponent_combos;
  const villainReach = node.opponent_reach;
  if (!heroCombos?.length || !heroReach?.length || heroCombos.length !== heroReach.length) {
    return { ok: false, reason: "Selected node does not expose acting-seat reach weights." };
  }
  if (
    !villainCombos?.length
    || !villainReach?.length
    || villainCombos.length !== villainReach.length
  ) {
    return { ok: false, reason: "Selected node does not expose opponent reach weights." };
  }

  const heroRange = rangeFromReach(heroCombos, heroReach);
  const villainRange = rangeFromReach(villainCombos, villainReach);
  if (!heroRange || !villainRange) {
    return { ok: false, reason: "Reach weights produced empty ranges." };
  }

  const acting = node.player ?? 0;
  const oopIsHero = acting === 0;
  const rawBoard = node.board;
  const board = Array.isArray(rawBoard)
    ? rawBoard.filter(Boolean)
    : typeof rawBoard === "string"
      ? rawBoard.trim().split(/[\s,]+/).filter(Boolean)
      : [];
  const draft = createDefaultEquityDraft();
  draft.name = `Study ${input.solutionId} / ${node.id}`;
  draft.board = board;
  draft.players[0] = {
    id: "p1",
    label: oopIsHero ? `OOP (seat ${acting})` : "OOP",
    enabled: true,
    rangeText: oopIsHero ? heroRange : villainRange,
  };
  draft.players[1] = {
    id: "p2",
    label: oopIsHero ? "IP" : `IP (seat ${acting})`,
    enabled: true,
    rangeText: oopIsHero ? villainRange : heroRange,
  };
  draft.selectedPlayerId = "p1";
  return { ok: true, draft };
}
