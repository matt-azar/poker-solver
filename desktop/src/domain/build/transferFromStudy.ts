/**
 * Create a Build SpotDraft from a Study street-start decision
 * (first OOP action of turn or river).
 *
 * Uses raw strategy-conditioned reaches (not posterior marginals) so the
 * engine applies opponent blockers once. Midstreet extraction is out of scope
 * until StreetConfig carries initial betting state.
 */
import type { PathStep } from "../actionHistory";
import { normalizeBoardCards } from "../cards";
import { rangeFromReach } from "../equity/transfer";
import {
  draftPartialFromSolutionConfig,
  openDraftBase,
} from "../setup/identity";
import type { SetupStudyMeta } from "../setup/setupTransaction";
import type { NodePayload, SpotDraft } from "../types";

export type BuildSpotStreet = "turn" | "river";

export type BuildSpotEligibility =
  | { ok: true; street: BuildSpotStreet }
  | { ok: false; reason: string };

export interface BuildSpotSource {
  solutionId: string;
  nodeId: string;
  line: string;
  street: BuildSpotStreet;
}

export interface BuildSpotTransferResult {
  ok: true;
  draft: SpotDraft;
  meta: SetupStudyMeta;
  source: BuildSpotSource;
  sourceActions: string[];
  warnings: string[];
  /** Donk sizes were folded into the starting-street OOP bets. */
  donkBaked: boolean;
}

export type BuildSpotTransferFailure = { ok: false; reason: string };

export type BuildSpotTransfer =
  | BuildSpotTransferResult
  | BuildSpotTransferFailure;

function finiteOrZero(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function boardTextFromNode(node: NodePayload): string {
  return normalizeBoardCards(node.board).join(" ");
}

/** Street-start OOP decision on a turn (4) or river (5) board. */
export function evaluateBuildSpotEligibility(
  node: NodePayload | null | undefined,
): BuildSpotEligibility {
  if (!node) {
    return { ok: false, reason: "No node loaded — solve a spot first." };
  }
  if (node.kind === "chance" || node.kind === "terminal") {
    return {
      ok: false,
      reason: "Open the first decision of the turn or river.",
    };
  }
  const boardLen = normalizeBoardCards(node.board).length;
  if (boardLen < 4) {
    return {
      ok: false,
      reason: "Create Build spot starts at a turn or river decision.",
    };
  }
  if (boardLen > 5) {
    return { ok: false, reason: "Unsupported board length for Build extraction." };
  }
  const street: BuildSpotStreet = boardLen === 5 ? "river" : "turn";
  if ((node.player ?? -1) !== 0) {
    return {
      ok: false,
      reason: `Create Build spot starts at OOP's first ${street} decision.`,
    };
  }
  if (finiteOrZero(node.to_call) !== 0) {
    return {
      ok: false,
      reason: "Midstreet spots with a facing bet are not supported yet.",
    };
  }
  const contrib = Array.isArray(node.contrib) ? node.contrib : [];
  if (finiteOrZero(contrib[0]) !== 0 || finiteOrZero(contrib[1]) !== 0) {
    return {
      ok: false,
      reason: "Midstreet spots with street contributions are not supported yet.",
    };
  }
  return { ok: true, street };
}

function isAggressionLabel(label: string | null | undefined): boolean {
  if (!label) {
    return false;
  }
  return /^(Bet|Raise)\b/i.test(label.trim());
}

/**
 * True when IP bet or raised on the street before the current board street.
 * Uses pathTrail actors when available; falls back to line token heuristics.
 */
export function priorStreetIpAggression(
  street: BuildSpotStreet,
  pathTrail: readonly PathStep[] | null | undefined,
  line: string | null | undefined,
): boolean {
  const priorStreet = street === "turn" ? "flop" : "turn";
  if (pathTrail && pathTrail.length > 0) {
    for (const step of pathTrail) {
      if (step.kind !== "action") {
        continue;
      }
      if (step.street !== priorStreet) {
        continue;
      }
      if (
        (step.actor === "IP" || step.actor === "ip") &&
        isAggressionLabel(step.rawLabel ?? step.label)
      ) {
        return true;
      }
    }
    // Trail present but no IP aggression recorded on the prior street.
    return false;
  }
  // Without a trail, a Bet/Raise anywhere in the closed prior line is a weak
  // positive signal that some seat aggressed — bake donk conservatively only
  // when the line clearly ends with an IP-facing pattern (Call after Bet/Raise).
  const tokens = String(line || "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (tokens.length < 2) {
    return false;
  }
  // Common flop IP barrel then call: …/Bet N/Call or Check/Bet N/Call.
  for (let i = 0; i < tokens.length - 1; i++) {
    if (isAggressionLabel(tokens[i]) && /^Call\b/i.test(tokens[i + 1] || "")) {
      return true;
    }
  }
  return false;
}

function mergeSizeLists(...parts: Array<string | null | undefined>): string {
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    for (const token of String(part || "").split(/[\s,]+/)) {
      const trimmed = token.trim();
      if (!trimmed || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      tokens.push(trimmed);
    }
  }
  return tokens.join(", ");
}

function sizeFieldHasGeometric(text: string): boolean {
  return /(?:^|[\s,])(\d+(?:\.\d+)?)?e(?:$|[\s,])/i.test(text);
}

function collectWarnings(draft: SpotDraft, source: BuildSpotSource): string[] {
  const warnings: string[] = [];
  warnings.push(
    `Extracted from ${source.solutionId} @ ${source.nodeId} (${source.street}: ${source.line || "root"}).`,
  );
  const sizeBlob = [
    draft.oopFlop,
    draft.ipFlop,
    draft.oopTurn,
    draft.ipTurn,
    draft.oopRiver,
    draft.ipRiver,
    draft.oopFlopRaises,
    draft.ipFlopRaises,
    draft.oopTurnRaises,
    draft.ipTurnRaises,
    draft.oopRiverRaises,
    draft.ipRiverRaises,
  ].join(",");
  if (sizeFieldHasGeometric(sizeBlob)) {
    warnings.push(
      "Geometric e / Ne sizes use streets left in the new tree — review them.",
    );
  }
  if (draft.allInThreshold > 0) {
    warnings.push(
      "All-in threshold is a fraction of the new starting stack — confirm it still fits.",
    );
  }
  if (draft.potCap > 0) {
    warnings.push("Pot cap still applies against the new pot.");
  }
  if (draft.useIcm) {
    warnings.push(
      "ICM stacks/payouts were cleared; chip EV is used until you restore ICM.",
    );
  }
  if (draft.incentives.trim() || draft.edgeTags.trim()) {
    warnings.push(
      "Path-scoped incentives / edge tags were cleared for the new spot.",
    );
  }
  if (draft.treeEdits.length > 0) {
    warnings.push("Tree edits from the source path were cleared.");
  }
  return warnings;
}

function bakeDonkIntoStartingStreet(
  draft: SpotDraft,
  street: BuildSpotStreet,
): { draft: SpotDraft; baked: boolean } {
  if (street === "turn") {
    const donk = draft.oopTurnDonk.trim() || (draft.donkTurn ? draft.oopTurn : "");
    if (!donk) {
      return {
        draft: {
          ...draft,
          oopTurnDonk: "",
          donkTurn: false,
          // Later-street donk may still apply after this turn tree.
        },
        baked: false,
      };
    }
    return {
      draft: {
        ...draft,
        oopTurn: mergeSizeLists(draft.oopTurn, donk),
        oopTurnDonk: "",
        donkTurn: false,
      },
      baked: true,
    };
  }
  const donk = draft.oopRiverDonk.trim() || (draft.donkRiver ? draft.oopRiver : "");
  if (!donk) {
    return {
      draft: {
        ...draft,
        oopRiverDonk: "",
        donkRiver: false,
        oopTurnDonk: "",
        donkTurn: false,
        oopFlopDonk: "",
        donkFlop: false,
      },
      baked: false,
    };
  }
  return {
    draft: {
      ...draft,
      oopRiver: mergeSizeLists(draft.oopRiver, donk),
      oopRiverDonk: "",
      donkRiver: false,
      oopTurnDonk: "",
      donkTurn: false,
      oopFlopDonk: "",
      donkFlop: false,
    },
    baked: true,
  };
}

function clearPastStreetSizes(draft: SpotDraft, street: BuildSpotStreet): SpotDraft {
  if (street === "turn") {
    // Four-card tree never plays a flop; clear flop lists so they cannot confuse.
    return {
      ...draft,
      oopFlop: "",
      ipFlop: "",
      oopFlopRaises: "",
      ipFlopRaises: "",
      oopFlopDonk: "",
      donkFlop: false,
    };
  }
  return {
    ...draft,
    oopFlop: "",
    ipFlop: "",
    oopFlopRaises: "",
    ipFlopRaises: "",
    oopFlopDonk: "",
    donkFlop: false,
    oopTurn: "",
    ipTurn: "",
    oopTurnRaises: "",
    ipTurnRaises: "",
    oopTurnDonk: "",
    donkTurn: false,
  };
}

/**
 * Build a reviewable SpotDraft from a Study street-start node + solution config.
 */
export function draftBuildSpotFromStudy(input: {
  node: NodePayload;
  solutionId: string;
  pathTrail?: readonly PathStep[] | null;
  /** GET /api/solutions/{id}/config when available. */
  config?: Record<string, unknown> | null;
  /** Current Build draft — used only for solve prefs (iterations, threads, …). */
  prefsDraft?: SpotDraft | null;
}): BuildSpotTransfer {
  const gate = evaluateBuildSpotEligibility(input.node);
  if (!gate.ok) {
    return gate;
  }
  const node = input.node;
  const acting = node.player ?? 0;
  const heroRange = rangeFromReach(node.combos, node.reach);
  const villainRange = rangeFromReach(node.opponent_combos, node.opponent_reach);
  if (!heroRange || !villainRange) {
    return {
      ok: false,
      reason: "Node does not expose usable raw reaching ranges for both seats.",
    };
  }
  const oopIsHero = acting === 0;
  const oopRange = oopIsHero ? heroRange : villainRange;
  const ipRange = oopIsHero ? villainRange : heroRange;

  const pot = finiteOrZero(node.pot);
  const stack = finiteOrZero(node.stack);
  if (!(pot > 0) || !(stack > 0)) {
    return {
      ok: false,
      reason: "Node pot and effective stack must be positive.",
    };
  }

  const boardText = boardTextFromNode(node);
  const source: BuildSpotSource = {
    solutionId: input.solutionId,
    nodeId: node.node_id,
    line: String(node.line || ""),
    street: gate.street,
  };

  let draft = openDraftBase("");
  if (input.config && typeof input.config === "object") {
    draft = { ...draft, ...draftPartialFromSolutionConfig(input.config) };
  }
  // Preserve solve preferences from the live Build draft when present.
  const prefs = input.prefsDraft;
  if (prefs) {
    draft = {
      ...draft,
      iterations: prefs.iterations,
      accuracy: prefs.accuracy,
      timeLimit: prefs.timeLimit,
      memoryMib: prefs.memoryMib,
      threads: prefs.threads,
      algorithm: prefs.algorithm,
      samples: prefs.samples,
      frozen: prefs.frozen,
    };
  }

  draft = {
    ...draft,
    boardText,
    pot,
    stack,
    oopRange,
    ipRange,
    // Path-scoped artifacts do not survive a new root.
    treeEdits: [],
    incentives: "",
    edgeTags: "",
    useIcm: false,
    icmStacks: "",
    icmPayouts: "",
    solutionPath: "",
  };

  draft = clearPastStreetSizes(draft, gate.street);

  const ipAggressed = priorStreetIpAggression(
    gate.street,
    input.pathTrail,
    source.line,
  );
  let donkBaked = false;
  if (ipAggressed) {
    const baked = bakeDonkIntoStartingStreet(draft, gate.street);
    draft = baked.draft;
    donkBaked = baked.baked;
  } else {
    // No prior IP aggression — donk lists are inert at a new root; clear them
    // on the starting street so Build does not imply a lead that cannot fire.
    if (gate.street === "turn") {
      draft = { ...draft, oopTurnDonk: "", donkTurn: false };
    } else {
      draft = {
        ...draft,
        oopRiverDonk: "",
        donkRiver: false,
        oopTurnDonk: "",
        donkTurn: false,
        oopFlopDonk: "",
        donkFlop: false,
      };
    }
  }

  const warnings = collectWarnings(draft, source);
  if (donkBaked) {
    warnings.push(
      "Prior-street IP aggression: donk sizes were merged into OOP's starting-street bets (new trees have no prior aggressor).",
    );
  } else if (ipAggressed) {
    warnings.push(
      "Prior-street IP aggression was detected but no donk sizes were configured on the source.",
    );
  }

  const meta: SetupStudyMeta = {
    profile: null,
    rangeSnapshot: { oop: oopRange, ip: ipRange },
    profileDataRevision: null,
    provenance: {
      boardText: "derived",
      pot: "derived",
      stack: "derived",
      oopRange: "derived",
      ipRange: "derived",
    },
    summary: [
      `Build spot from Study ${source.solutionId}`,
      `${source.street} · ${source.line || source.nodeId}`,
      ...warnings.slice(1),
    ],
    conflicts: [],
    missing: [],
    canSolve: Boolean(boardText && oopRange && ipRange && pot > 0 && stack > 0),
  };

  return {
    ok: true,
    draft,
    meta,
    source,
    sourceActions: [...(node.actions ?? [])],
    warnings,
    donkBaked,
  };
}

/** Compare preview root action labels to the source node's legal actions. */
export function compareRootActions(
  sourceActions: readonly string[],
  previewRootActions: readonly string[],
): { match: boolean; missing: string[]; extra: string[] } {
  const source = [...sourceActions];
  const preview = [...previewRootActions];
  const missing = source.filter((label) => !preview.includes(label));
  const extra = preview.filter((label) => !source.includes(label));
  return {
    match: missing.length === 0 && extra.length === 0,
    missing,
    extra,
  };
}
