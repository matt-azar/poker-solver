import { actorLabel, strategyFrequencies, type PathStep } from "../actionHistory";
import { groupEv, groupHands } from "../browse";
import {
  equityByCombo,
  equityHandsForNode,
  groupEquity,
  type EquityPayloadLike,
} from "../matrixDisplay";
import type {
  ActionValuesPayload,
  EvDisplayBasis,
  NodePayload,
  SolvePhase,
  SpotDraft,
  StatusPayload,
} from "../types";
import {
  LIST_BLUFF_CANDIDATES_TOOL,
  QUERY_NODE_STRATEGY_TOOL,
  QUERY_SELECTED_HAND_TOOL,
  STUDY_EVIDENCE_DEFERRED_TOOLS,
} from "./studyEvidence";

/** Schema version for assistant request context snapshots. */
export const ASSISTANT_CONTEXT_SNAPSHOT_VERSION = 2 as const;

/**
 * Bounded read-only tools for Study-page evidence.
 * Executable tools fetch via the Study analysis scheduler with work/memory limits;
 * runout/compare remain deferred.
 */
export const SELECTED_HAND_ANALYSIS_TOOL_SCHEMA = {
  name: QUERY_SELECTED_HAND_TOOL.name,
  description: QUERY_SELECTED_HAND_TOOL.description,
  parameters: QUERY_SELECTED_HAND_TOOL.parameters,
  status: "bounded_read" as const,
  deferredTools: STUDY_EVIDENCE_DEFERRED_TOOLS,
};

export const STUDY_NODE_EVIDENCE_TOOL_NAMES = [
  QUERY_NODE_STRATEGY_TOOL.name,
  LIST_BLUFF_CANDIDATES_TOOL.name,
  QUERY_SELECTED_HAND_TOOL.name,
] as const;

export interface AssistantContextBuildIdentity {
  kind: "build_draft";
  draftRevision: number;
  board: string | null;
  pot: number;
  stack: number;
  /** Engine solve-rake for this simulation (independent of range-source). */
  solveRake: { rate: number; cap: number };
  /** Catalogue / provenance stakes label when known; not solve rake. */
  rangeSourceLabel: string | null;
  oopRangePreview: string;
  ipRangePreview: string;
}

export interface AssistantContextPublishedSolution {
  present: boolean;
  solutionId: string | null;
  statusGeneration: number | null;
  board: string | null;
  pot: number | null;
  stack: number | null;
  nashGap: number | null;
  iterations: number | null;
  phase: SolvePhase | string;
  absence?: string;
}

export interface AssistantContextStudyNode {
  present: boolean;
  nodeId: string | null;
  kind: string | null;
  line: string | null;
  /** Compact path labels from Study pathTrail (root → current). */
  path: string[];
  board: string | null;
  /** Acting seat when known: IP / OOP / Deal. */
  seat: string | null;
  toAct: string | null;
  actions: string[];
  /** Posterior action mix for the acting seat when strategy is loaded. */
  strategy: Array<{ action: string; frequency: number }> | null;
  toCall: number | null;
  pot: number | null;
  stacks: number[] | null;
  absence?: string;
}

export interface AssistantContextSelectedHand {
  present: boolean;
  label: string | null;
  strategy: Array<{ action: string; frequency: number }> | null;
  mixedEv: number | null;
  equity: number | null;
  evBasis: EvDisplayBasis | null;
  absence: string[];
}

export interface AssistantContextReadiness {
  hasPublishedSolution: boolean;
  hasDecisionNode: boolean;
  strategyLoaded: boolean;
  actionEvReady: boolean;
  equityReady: boolean;
  convergenceAvailable: boolean;
}

export interface AssistantContextSnapshot {
  version: typeof ASSISTANT_CONTEXT_SNAPSHOT_VERSION;
  /** Monetary units for Build draft pot/stack and node chip fields. */
  units: "bb";
  build: AssistantContextBuildIdentity;
  publishedSolution: AssistantContextPublishedSolution;
  studyNode: AssistantContextStudyNode;
  selectedHand: AssistantContextSelectedHand;
  readiness: AssistantContextReadiness;
  /** Explicit statements when strategy / EV / convergence evidence is missing. */
  absences: string[];
  /** Compact UI parts, e.g. ["Build draft", "Study node", "selected hand"]. */
  indicatorParts: string[];
}

export interface BuildAssistantContextSnapshotInput {
  draft: SpotDraft;
  draftRevision: number;
  rangeSourceLabel?: string | null;
  solutionId?: string | null;
  status?: StatusPayload | null;
  phase?: SolvePhase | string | null;
  currentNode?: NodePayload | null;
  pathTrail?: PathStep[] | null;
  nodeValues?: ActionValuesPayload | null;
  equity?: EquityPayloadLike | null;
  selectedCell?: { text: string } | null;
  evDisplayBasis?: EvDisplayBasis;
}

function previewRange(text: string, max = 48): string {
  const trimmed = text.trim();
  if (!trimmed) return "(empty)";
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

/** Published / node boards only — never fall back to the Build draft. */
function publishedBoardLabel(
  board: string[] | string | null | undefined,
): string | null {
  if (Array.isArray(board) && board.length > 0) {
    return board.join("");
  }
  if (typeof board === "string" && board.trim()) {
    return board.trim();
  }
  return null;
}

function toActLabel(node: NodePayload): string | null {
  if (node.kind === "chance") return "Deal";
  const label = actorLabel(node.to_act, node.player);
  return label === "—" ? null : label;
}

function selectedHandStrategy(
  node: NodePayload,
  label: string,
): Array<{ action: string; frequency: number }> | null {
  const cell = groupHands(node).find((entry) => entry.text === label);
  if (!cell || !cell.defined || cell.marginalSum <= 0) {
    return null;
  }
  const actions = node.actions ?? [];
  if (actions.length === 0) return null;
  return actions.map((action, index) => ({
    action,
    frequency: cell.actionMass[index] / cell.marginalSum,
  }));
}

function nodeStrategyMix(
  node: NodePayload,
): Array<{ action: string; frequency: number }> | null {
  if (!node.strategy || !node.reach_defined || !(node.actions?.length)) {
    return null;
  }
  const freqs = strategyFrequencies(node);
  return (node.actions ?? []).map((action, index) => ({
    action,
    frequency: freqs[index] ?? 0,
  }));
}

/**
 * Build a versioned study context snapshot for assistant requests.
 * Separate Build-draft and published-solution identities; never invent strategy/EV.
 */
export function buildAssistantContextSnapshot(
  input: BuildAssistantContextSnapshotInput,
): AssistantContextSnapshot {
  const draft = input.draft;
  const basis = input.evDisplayBasis ?? "local";
  const phase = input.phase ?? "idle";
  const solutionId = input.solutionId ?? input.status?.solution_id ?? null;
  const node = input.currentNode ?? null;
  const pathTrail = input.pathTrail ?? [];
  const absences: string[] = [];
  const indicatorParts: string[] = ["Build draft"];

  const build: AssistantContextBuildIdentity = {
    kind: "build_draft",
    draftRevision: input.draftRevision,
    board: draft.boardText.trim() || null,
    pot: draft.pot,
    stack: draft.stack,
    solveRake: { rate: draft.rakeRate, cap: draft.rakeCap },
    rangeSourceLabel: input.rangeSourceLabel?.trim() || null,
    oopRangePreview: previewRange(draft.oopRange),
    ipRangePreview: previewRange(draft.ipRange),
  };

  let publishedSolution: AssistantContextPublishedSolution;
  if (solutionId) {
    publishedSolution = {
      present: true,
      solutionId,
      statusGeneration: input.status?.status_generation ?? null,
      board: publishedBoardLabel(input.status?.board ?? node?.board),
      pot: input.status?.pot ?? null,
      stack: input.status?.stack ?? null,
      nashGap:
        typeof input.status?.nash_gap === "number" ? input.status.nash_gap : null,
      iterations:
        typeof input.status?.iterations === "number" ? input.status.iterations : null,
      phase,
    };
  } else {
    const absence = "No published solution — strategy and EV evidence are unavailable.";
    absences.push(absence);
    publishedSolution = {
      present: false,
      solutionId: null,
      statusGeneration: null,
      board: null,
      pot: null,
      stack: null,
      nashGap: null,
      iterations: null,
      phase,
      absence,
    };
  }

  let studyNode: AssistantContextStudyNode;
  if (node?.node_id) {
    indicatorParts.push("Study node");
    const strategy = nodeStrategyMix(node);
    if (node.kind === "decision" && !strategy) {
      absences.push(
        "Node-level strategy frequencies are not loaded for the current Study node.",
      );
    }
    studyNode = {
      present: true,
      nodeId: node.node_id,
      kind: node.kind ?? null,
      line: node.line ?? node.node_id,
      path: pathTrail.map((step) => step.label).filter(Boolean),
      board: publishedBoardLabel(node.board),
      seat: toActLabel(node),
      toAct: toActLabel(node),
      actions: [...(node.actions ?? [])],
      strategy,
      toCall: typeof node.to_call === "number" ? node.to_call : null,
      pot: typeof node.pot === "number" ? node.pot : null,
      stacks: Array.isArray(node.stacks) ? [...node.stacks] : null,
    };
  } else {
    const absence = "No Study node selected — decision path and action labels are unavailable.";
    absences.push(absence);
    studyNode = {
      present: false,
      nodeId: null,
      kind: null,
      line: null,
      path: [],
      board: null,
      seat: null,
      toAct: null,
      actions: [],
      strategy: null,
      toCall: null,
      pot: null,
      stacks: null,
      absence,
    };
  }

  const handLabel = input.selectedCell?.text?.trim() || null;
  const handAbsence: string[] = [];
  let strategy: AssistantContextSelectedHand["strategy"] = null;
  let mixedEv: number | null = null;
  let handEquity: number | null = null;

  if (!handLabel) {
    handAbsence.push("No hand selected in the Study matrix.");
  } else {
    indicatorParts.push("selected hand");
    if (!node?.node_id) {
      handAbsence.push(
        `Selected hand ${handLabel}: no Study node — strategy frequencies are missing.`,
      );
    } else if (!node.strategy || !node.reach_defined) {
      handAbsence.push(
        `Selected hand ${handLabel}: strategy frequencies are not loaded for this node.`,
      );
    } else {
      strategy = selectedHandStrategy(node, handLabel);
      if (!strategy) {
        handAbsence.push(
          `Selected hand ${handLabel}: no matching strategy mass at this node.`,
        );
      }
    }

    if (!input.nodeValues || input.nodeValues.pending) {
      handAbsence.push(
        `Selected hand ${handLabel}: action EV evidence is missing (not calculated or still pending).`,
      );
    } else if (node) {
      const cell = groupHands(node).find((entry) => entry.text === handLabel);
      const ev = cell ? groupEv(node, input.nodeValues, cell, basis) : null;
      if (ev) {
        mixedEv = ev.mixed;
      } else {
        handAbsence.push(
          `Selected hand ${handLabel}: action EV evidence is missing for this node.`,
        );
      }
    }

    if (node && input.equity && !input.equity.pending) {
      const cell = groupHands(node).find((entry) => entry.text === handLabel);
      const hands = equityHandsForNode(input.equity, node.player);
      handEquity = cell ? groupEquity(cell, equityByCombo(hands), node) : null;
      if (handEquity == null) {
        handAbsence.push(
          `Selected hand ${handLabel}: equity evidence is missing for this cell.`,
        );
      }
    } else if (handLabel) {
      handAbsence.push(
        `Selected hand ${handLabel}: equity evidence is missing (not calculated or still pending).`,
      );
    }
  }

  for (const line of handAbsence) {
    if (!absences.includes(line)) absences.push(line);
  }

  const convergenceAvailable =
    typeof publishedSolution.nashGap === "number" && Number.isFinite(publishedSolution.nashGap);
  if (publishedSolution.present && !convergenceAvailable) {
    absences.push("Convergence (NashConv) is not available on the published solution status.");
  }

  const equityReady = Boolean(
    node?.node_id &&
      input.equity &&
      !input.equity.pending &&
      equityHandsForNode(input.equity, node.player)?.length,
  );

  const readiness: AssistantContextReadiness = {
    hasPublishedSolution: publishedSolution.present,
    hasDecisionNode: Boolean(node?.node_id && node.kind === "decision"),
    strategyLoaded: Boolean(node?.strategy && node.reach_defined),
    actionEvReady: Boolean(
      input.nodeValues &&
        !input.nodeValues.pending &&
        Array.isArray(input.nodeValues.ev_defined) &&
        input.nodeValues.ev_defined.some(Boolean),
    ),
    equityReady,
    convergenceAvailable,
  };

  return {
    version: ASSISTANT_CONTEXT_SNAPSHOT_VERSION,
    units: "bb",
    build,
    publishedSolution,
    studyNode,
    selectedHand: {
      present: Boolean(handLabel),
      label: handLabel,
      strategy,
      mixedEv,
      equity: handEquity,
      evBasis: handLabel ? basis : null,
      absence: handAbsence,
    },
    readiness,
    absences,
    indicatorParts,
  };
}

/** Compact UI indicator, e.g. "Context: Build draft / Study node / selected hand". */
export function formatContextIndicator(snapshot: AssistantContextSnapshot): string {
  return `Context: ${snapshot.indicatorParts.join(" / ")}`;
}

/**
 * Compact request summary derived from the snapshot (replaces ad-hoc setupSummary).
 * Omits full range weight strings — previews only.
 */
export function summarizeContextSnapshot(snapshot: AssistantContextSnapshot): string {
  const bits = [
    `v${snapshot.version}`,
    `units=${snapshot.units}`,
    `buildRev=${snapshot.build.draftRevision}`,
    `board=${snapshot.build.board ?? "(none)"}`,
    `pot=${snapshot.build.pot}`,
    `stack=${snapshot.build.stack}`,
    `solveRake=rate:${snapshot.build.solveRake.rate}/cap:${snapshot.build.solveRake.cap}`,
    `rangeSource=${snapshot.build.rangeSourceLabel ?? "n/a"}`,
    `oop=${snapshot.build.oopRangePreview}`,
    `ip=${snapshot.build.ipRangePreview}`,
  ];
  if (snapshot.publishedSolution.present) {
    bits.push(`solution=${snapshot.publishedSolution.solutionId}`);
    if (snapshot.publishedSolution.nashGap != null) {
      bits.push(`nashGap=${snapshot.publishedSolution.nashGap}`);
    }
  } else {
    bits.push("solution=(none)");
  }
  if (snapshot.studyNode.present) {
    bits.push(`node=${snapshot.studyNode.nodeId}`);
    bits.push(`line=${snapshot.studyNode.line ?? "?"}`);
    if (snapshot.studyNode.seat) {
      bits.push(`seat=${snapshot.studyNode.seat}`);
    }
    if (snapshot.studyNode.path.length) {
      bits.push(`path=${snapshot.studyNode.path.join(">")}`);
    }
    if (snapshot.studyNode.toCall != null) {
      bits.push(`toCall=${snapshot.studyNode.toCall}`);
    }
    if (snapshot.studyNode.actions.length) {
      bits.push(`actions=${snapshot.studyNode.actions.join(",")}`);
    }
    if (snapshot.studyNode.strategy) {
      bits.push(
        `nodeStrategy=${snapshot.studyNode.strategy
          .map((s) => `${s.action}:${(s.frequency * 100).toFixed(0)}%`)
          .join(",")}`,
      );
    }
  } else {
    bits.push("node=(none)");
  }
  if (snapshot.selectedHand.present) {
    bits.push(`hand=${snapshot.selectedHand.label}`);
    if (snapshot.selectedHand.strategy) {
      bits.push(
        `strategy=${snapshot.selectedHand.strategy
          .map((s) => `${s.action}:${(s.frequency * 100).toFixed(0)}%`)
          .join(",")}`,
      );
    }
    if (snapshot.selectedHand.mixedEv != null) {
      bits.push(`mixedEv=${snapshot.selectedHand.mixedEv.toFixed(3)}`);
    }
    if (snapshot.selectedHand.equity != null) {
      bits.push(`equity=${snapshot.selectedHand.equity.toFixed(3)}`);
    }
  } else {
    bits.push("hand=(none)");
  }
  bits.push(
    `ready=sol:${snapshot.readiness.hasPublishedSolution ? 1 : 0}/node:${
      snapshot.readiness.hasDecisionNode ? 1 : 0
    }/strat:${snapshot.readiness.strategyLoaded ? 1 : 0}/ev:${
      snapshot.readiness.actionEvReady ? 1 : 0
    }/eq:${snapshot.readiness.equityReady ? 1 : 0}/conv:${
      snapshot.readiness.convergenceAvailable ? 1 : 0
    }`,
  );
  if (snapshot.absences.length) {
    bits.push(`absences=${snapshot.absences.length}`);
  }
  return bits.join(" ");
}
