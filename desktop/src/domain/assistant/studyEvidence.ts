/**
 * Bounded Study-page evidence tools for the floating assistant.
 *
 * Read-only: strategy / bluff listing / selected-hand summary. May navigate a
 * few hops and wait on the existing analysis scheduler. Never starts a solve,
 * opens the filesystem, or performs unrestricted HTTP.
 */
import {
  actorLabel,
  nextChoicesFromNode,
  strategyFrequencies,
  type PathStep,
} from "../actionHistory";
import { analysisErrorIsPermanent, analysisPayloadReady } from "../setup/identity";
import { groupEv, groupHands } from "../browse";
import {
  equityByCombo,
  equityHandsForNode,
  groupEquity,
  type EquityPayloadLike,
} from "../matrixDisplay";
import {
  DEFAULT_VALUE_BLUFFS_EQUITY_THRESHOLD,
  listValueBluffs,
  type ValueBluffsSortKey,
} from "../valueBluffs";
import type {
  ActionValuesPayload,
  EvDisplayBasis,
  NodePayload,
  StatusPayload,
} from "../types";

/** Equity page as stored on Study (may carry pending/error/identity). */
export type StudyEvidenceEquity = EquityPayloadLike & {
  pending?: boolean;
  error?: string;
  node_id?: string;
  solution_id?: string;
};

export const ASSISTANT_EVIDENCE_LIMITS = {
  maxBluffRows: 25,
  maxNavHops: 2,
  analysisWaitMs: 12_000,
  pollIntervalMs: 120,
} as const;

export type StudyEvidenceSeat = "IP" | "OOP";

export interface StudyEvidenceLiveState {
  solutionId: string | null;
  currentNode: NodePayload | null;
  nodeValues: ActionValuesPayload | null;
  equity: StudyEvidenceEquity | null;
  pathTrail: PathStep[];
  selectedCell: { text: string } | null;
  evDisplayBasis: EvDisplayBasis;
  status: StatusPayload | null;
}

export interface StudyEvidenceHost {
  read: () => StudyEvidenceLiveState;
  /** Warm EV + equity via Study's analysis scheduler (user/auto priority). */
  ensureNodeAnalysis: () => Promise<void>;
  /**
   * Bounded behind-the-scenes navigation. Prefer history:"none" in the store
   * wrapper so assistant hops do not spam Back/Forward.
   */
  navigateTo: (nodeId: string) => Promise<void>;
  /** Optional peek without changing Study selection (engine getNode). */
  fetchNode?: (nodeId: string) => Promise<NodePayload>;
}

export const QUERY_NODE_STRATEGY_TOOL = {
  name: "query_node_strategy",
  description:
    "Read-only posterior action mix for IP or OOP at the current Study decision (or a nearby decision after at most 2 behind-the-scenes hops). Does not start a solve.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      seat: {
        type: "string",
        enum: ["IP", "OOP"],
        description: "Seat whose strategy to read. Defaults to the acting seat.",
      },
    },
  },
} as const;

export const LIST_BLUFF_CANDIDATES_TOOL = {
  name: "list_bluff_candidates",
  description:
    "List betting bluff candidates for IP or OOP at the current (or nearby) decision: combo, bet frequency, EV when loaded, equity when loaded. Uses the Value/Bluffs join (strategy + equity + values). Fetches missing EV/equity only through the Study analysis scheduler. Does not start a solve.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      seat: {
        type: "string",
        enum: ["IP", "OOP"],
        description: "Seat to list bluffs for. Defaults to the acting seat.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: ASSISTANT_EVIDENCE_LIMITS.maxBluffRows,
        description: `Max rows (default 15, hard cap ${ASSISTANT_EVIDENCE_LIMITS.maxBluffRows}).`,
      },
      equityThreshold: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description:
          "Exclusive equity upper bound for bluffs (default 0.30, same as Study Value/Bluffs).",
      },
      sortBy: {
        type: "string",
        enum: ["betFreq", "ev", "equity"],
        description: "Sort key (default betFreq descending).",
      },
    },
  },
} as const;

export const QUERY_SELECTED_HAND_TOOL = {
  name: "query_selected_hand_analysis",
  description:
    "Read-only summary of the currently selected matrix hand: strategy frequencies, mixed EV, and equity when already loaded or after a bounded scheduler wait. Does not start a solve, fetch runouts, or compare scenarios.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
} as const;

/** Tools the model may invoke for Study evidence (bounded). */
export const STUDY_EVIDENCE_TOOL_SCHEMAS = [
  QUERY_NODE_STRATEGY_TOOL,
  LIST_BLUFF_CANDIDATES_TOOL,
  QUERY_SELECTED_HAND_TOOL,
] as const;

export const STUDY_EVIDENCE_DEFERRED_TOOLS = [
  "compare_runouts",
  "compare_baseline_scenario",
] as const;

export type StudyEvidenceToolName =
  (typeof STUDY_EVIDENCE_TOOL_SCHEMAS)[number]["name"];

export function isStudyEvidenceToolName(name: string): name is StudyEvidenceToolName {
  return STUDY_EVIDENCE_TOOL_SCHEMAS.some((tool) => tool.name === name);
}

export interface NodeStrategyEvidence {
  ok: boolean;
  seat: StudyEvidenceSeat | null;
  nodeId: string | null;
  line: string | null;
  path: string[];
  actions: Array<{ action: string; frequency: number }>;
  navigated: boolean;
  hops: number;
  absences: string[];
}

export interface BluffCandidateRow {
  combo: string;
  betFreq: number;
  ev: number | null;
  equity: number;
  topBetAction: string | null;
  reach: number | null;
}

export interface BluffCandidatesEvidence {
  ok: boolean;
  seat: StudyEvidenceSeat | null;
  nodeId: string | null;
  line: string | null;
  path: string[];
  equityThreshold: number;
  sortBy: ValueBluffsSortKey;
  rows: BluffCandidateRow[];
  truncated: boolean;
  navigated: boolean;
  hops: number;
  absences: string[];
}

export interface SelectedHandEvidence {
  ok: boolean;
  label: string | null;
  nodeId: string | null;
  strategy: Array<{ action: string; frequency: number }> | null;
  mixedEv: number | null;
  equity: number | null;
  evBasis: EvDisplayBasis | null;
  absences: string[];
}

function pathLabels(trail: PathStep[]): string[] {
  return trail.map((step) => step.label).filter(Boolean);
}

function normalizeSeat(raw: unknown, fallback: StudyEvidenceSeat | null): StudyEvidenceSeat | null {
  if (typeof raw === "string") {
    const upper = raw.trim().toUpperCase();
    if (upper === "IP" || upper === "OOP") {
      return upper;
    }
  }
  return fallback;
}

function actingSeat(node: NodePayload | null | undefined): StudyEvidenceSeat | null {
  if (!node || node.kind === "chance" || node.kind === "terminal") {
    return null;
  }
  const label = actorLabel(node.to_act, node.player).toUpperCase();
  if (label === "IP" || label === "OOP") {
    return label;
  }
  return null;
}

function seatMatches(node: NodePayload, seat: StudyEvidenceSeat): boolean {
  return actingSeat(node) === seat;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Prefer passive lines (Check, then Call) when hopping toward the other seat,
 * matching common “after check, IP…” study questions.
 */
function preferredChildIds(node: NodePayload): string[] {
  const choices = nextChoicesFromNode(node);
  const scored = choices
    .filter((choice) => Boolean(choice.nodeId))
    .map((choice) => {
      const label = choice.label.trim().toLowerCase();
      let rank = 50;
      if (choice.kind === "action" && /^check\b/.test(label)) rank = 0;
      else if (choice.kind === "action" && /^call\b/.test(label)) rank = 1;
      else if (choice.kind === "card") rank = 10;
      else if (choice.kind === "action" && /^(bet|raise|all)/.test(label)) rank = 20;
      return { nodeId: choice.nodeId as string, rank };
    });
  scored.sort((left, right) => left.rank - right.rank);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of scored) {
    if (seen.has(entry.nodeId)) continue;
    seen.add(entry.nodeId);
    out.push(entry.nodeId);
  }
  return out;
}

async function peekNode(
  host: StudyEvidenceHost,
  nodeId: string,
): Promise<NodePayload | null> {
  const live = host.read().currentNode;
  if (live?.node_id === nodeId) {
    return live;
  }
  if (!host.fetchNode) {
    return null;
  }
  try {
    return await host.fetchNode(nodeId);
  } catch {
    return null;
  }
}

/**
 * Find a decision node where `seat` acts, within maxNavHops of the live node.
 * Peeks via fetchNode when hopping; caller navigates once to the target.
 */
export async function findSeatDecisionNodeId(
  host: StudyEvidenceHost,
  seat: StudyEvidenceSeat,
  maxHops = ASSISTANT_EVIDENCE_LIMITS.maxNavHops,
): Promise<{ nodeId: string; hops: number } | { absence: string }> {
  const start = host.read().currentNode;
  if (!start?.node_id) {
    return { absence: "No Study node selected — cannot read strategy." };
  }
  if (start.kind === "decision" && seatMatches(start, seat)) {
    return { nodeId: start.node_id, hops: 0 };
  }

  if (!host.fetchNode) {
    // Without peek, only try the first preferred child (one hop).
    const childId = preferredChildIds(start)[0];
    if (!childId || maxHops < 1) {
      return {
        absence: `Current node is not ${seat} to act, and child peek is unavailable.`,
      };
    }
    return { nodeId: childId, hops: 1 };
  }

  type QueueEntry = { nodeId: string; hops: number };
  const queue: QueueEntry[] = [{ nodeId: start.node_id, hops: 0 }];
  const visited = new Set<string>([start.node_id]);
  const byId = new Map<string, NodePayload>([[start.node_id, start]]);

  while (queue.length) {
    const current = queue.shift()!;
    let node = byId.get(current.nodeId) ?? null;
    if (!node) {
      node = await peekNode(host, current.nodeId);
      if (node) {
        byId.set(current.nodeId, node);
      }
    }
    if (!node) {
      continue;
    }
    if (
      current.hops > 0 &&
      node.kind === "decision" &&
      seatMatches(node, seat)
    ) {
      return { nodeId: node.node_id, hops: current.hops };
    }
    if (current.hops >= maxHops) {
      continue;
    }
    for (const childId of preferredChildIds(node)) {
      if (visited.has(childId)) continue;
      visited.add(childId);
      queue.push({ nodeId: childId, hops: current.hops + 1 });
    }
  }

  return {
    absence: `No ${seat} decision node within ${maxHops} hops of the current Study node.`,
  };
}

async function ensureSeatNode(
  host: StudyEvidenceHost,
  seat: StudyEvidenceSeat,
): Promise<{
  node: NodePayload;
  navigated: boolean;
  hops: number;
  path: string[];
} | { absences: string[] }> {
  const found = await findSeatDecisionNodeId(host, seat);
  if ("absence" in found) {
    return { absences: [found.absence] };
  }
  const live = host.read();
  let navigated = false;
  if (live.currentNode?.node_id !== found.nodeId) {
    await host.navigateTo(found.nodeId);
    navigated = true;
  }
  const after = host.read();
  const node = after.currentNode;
  if (!node?.node_id || node.node_id !== found.nodeId) {
    return {
      absences: [`Failed to open Study node ${found.nodeId} for ${seat}.`],
    };
  }
  if (node.kind !== "decision" || !seatMatches(node, seat)) {
    return {
      absences: [
        `Node ${node.node_id} is not a ${seat} decision (to_act=${actorLabel(node.to_act, node.player)}).`,
      ],
    };
  }
  return {
    node,
    navigated,
    hops: found.hops,
    path: pathLabels(after.pathTrail),
  };
}

async function waitForAnalysis(
  host: StudyEvidenceHost,
  needs: { values?: boolean; equity?: boolean },
): Promise<string[]> {
  const absences: string[] = [];
  const state0 = host.read();
  if (!state0.solutionId || !state0.currentNode?.node_id) {
    return ["No published solution/node — analysis cannot be fetched."];
  }
  await host.ensureNodeAnalysis();
  const nodeId = state0.currentNode.node_id;
  const solutionId = state0.solutionId;
  const deadline = Date.now() + ASSISTANT_EVIDENCE_LIMITS.analysisWaitMs;

  while (Date.now() < deadline) {
    const live = host.read();
    if (live.currentNode?.node_id !== nodeId || live.solutionId !== solutionId) {
      absences.push("Study node changed while waiting for analysis.");
      return absences;
    }
    const valuesOk =
      !needs.values ||
      analysisPayloadReady(live.nodeValues, solutionId, nodeId);
    const equityOk =
      !needs.equity || analysisPayloadReady(live.equity, solutionId, nodeId);

    if (needs.values && live.nodeValues?.error) {
      if (analysisErrorIsPermanent(live.nodeValues.error)) {
        absences.push(
          `Action EV unavailable (work/memory limit or permanent error): ${live.nodeValues.error}`,
        );
      }
    }
    if (needs.equity && live.equity?.error) {
      if (analysisErrorIsPermanent(live.equity.error)) {
        absences.push(
          `Equity unavailable (work/memory limit or permanent error): ${live.equity.error}`,
        );
      }
    }
    if (absences.length) {
      return absences;
    }
    if (valuesOk && equityOk) {
      return [];
    }
    await sleep(ASSISTANT_EVIDENCE_LIMITS.pollIntervalMs);
  }

  const live = host.read();
  if (needs.values && !analysisPayloadReady(live.nodeValues, solutionId, nodeId)) {
    absences.push("Action EV did not become ready within the assistant wait budget.");
  }
  if (needs.equity && !analysisPayloadReady(live.equity, solutionId, nodeId)) {
    absences.push("Equity did not become ready within the assistant wait budget.");
  }
  return absences;
}

export async function queryNodeStrategy(
  host: StudyEvidenceHost,
  args: Record<string, unknown> = {},
): Promise<NodeStrategyEvidence> {
  const live = host.read();
  const seat = normalizeSeat(args.seat, actingSeat(live.currentNode));
  if (!seat) {
    return {
      ok: false,
      seat: null,
      nodeId: live.currentNode?.node_id ?? null,
      line: live.currentNode?.line ?? null,
      path: pathLabels(live.pathTrail),
      actions: [],
      navigated: false,
      hops: 0,
      absences: [
        "Could not determine seat (IP/OOP). Pass seat explicitly or open a decision node.",
      ],
    };
  }
  if (!live.solutionId) {
    return {
      ok: false,
      seat,
      nodeId: null,
      line: null,
      path: pathLabels(live.pathTrail),
      actions: [],
      navigated: false,
      hops: 0,
      absences: ["No published solution — strategy evidence is unavailable."],
    };
  }

  const resolved = await ensureSeatNode(host, seat);
  if ("absences" in resolved) {
    return {
      ok: false,
      seat,
      nodeId: live.currentNode?.node_id ?? null,
      line: live.currentNode?.line ?? null,
      path: pathLabels(host.read().pathTrail),
      actions: [],
      navigated: false,
      hops: 0,
      absences: resolved.absences,
    };
  }

  const { node, navigated, hops, path } = resolved;
  const absences: string[] = [];
  if (!node.strategy || !node.reach_defined) {
    absences.push(`Strategy frequencies are not loaded for node ${node.node_id}.`);
    return {
      ok: false,
      seat,
      nodeId: node.node_id,
      line: node.line ?? node.node_id,
      path,
      actions: [],
      navigated,
      hops,
      absences,
    };
  }

  const labels = node.actions ?? [];
  const freqs = strategyFrequencies(node);
  return {
    ok: true,
    seat,
    nodeId: node.node_id,
    line: node.line ?? node.node_id,
    path,
    actions: labels.map((action, index) => ({
      action,
      frequency: freqs[index] ?? 0,
    })),
    navigated,
    hops,
    absences,
  };
}

export async function listBluffCandidates(
  host: StudyEvidenceHost,
  args: Record<string, unknown> = {},
): Promise<BluffCandidatesEvidence> {
  const live = host.read();
  const seat = normalizeSeat(args.seat, actingSeat(live.currentNode));
  const sortByRaw = typeof args.sortBy === "string" ? args.sortBy : "betFreq";
  const sortBy: ValueBluffsSortKey =
    sortByRaw === "ev" || sortByRaw === "equity" || sortByRaw === "betFreq"
      ? sortByRaw
      : "betFreq";
  const equityThreshold =
    typeof args.equityThreshold === "number" && Number.isFinite(args.equityThreshold)
      ? Math.min(1, Math.max(0, args.equityThreshold))
      : DEFAULT_VALUE_BLUFFS_EQUITY_THRESHOLD;
  const limitRaw =
    typeof args.limit === "number" && Number.isFinite(args.limit)
      ? Math.trunc(args.limit)
      : 15;
  const limit = Math.min(
    ASSISTANT_EVIDENCE_LIMITS.maxBluffRows,
    Math.max(1, limitRaw),
  );

  const empty = (
    absences: string[],
    partial?: Partial<BluffCandidatesEvidence>,
  ): BluffCandidatesEvidence => ({
    ok: false,
    seat,
    nodeId: live.currentNode?.node_id ?? null,
    line: live.currentNode?.line ?? null,
    path: pathLabels(host.read().pathTrail),
    equityThreshold,
    sortBy,
    rows: [],
    truncated: false,
    navigated: false,
    hops: 0,
    absences,
    ...partial,
  });

  if (!seat) {
    return empty([
      "Could not determine seat (IP/OOP). Pass seat explicitly or open a decision node.",
    ]);
  }
  if (!live.solutionId) {
    return empty(["No published solution — bluff evidence is unavailable."]);
  }

  const resolved = await ensureSeatNode(host, seat);
  if ("absences" in resolved) {
    return empty(resolved.absences);
  }

  const { node, navigated, hops, path } = resolved;
  if (!node.strategy || !node.reach_defined) {
    return empty(
      [`Strategy frequencies are not loaded for node ${node.node_id}.`],
      { nodeId: node.node_id, line: node.line ?? node.node_id, path, navigated, hops },
    );
  }

  const waitAbsences = await waitForAnalysis(host, { values: true, equity: true });
  const after = host.read();
  const equityHandsRaw = equityHandsForNode(after.equity, node.player);
  const absences = [...waitAbsences];
  if (!equityHandsRaw?.length) {
    absences.push(
      "Equity hands are missing for the acting seat — cannot classify bluffs vs the equity threshold.",
    );
    return empty(absences, {
      nodeId: node.node_id,
      line: node.line ?? node.node_id,
      path,
      navigated,
      hops,
    });
  }
  const equityHands = equityHandsRaw.map((hand) => ({
    combo: hand.combo,
    equity: Number(hand.equity),
    weight: Number(hand.weight ?? 0),
  }));

  const listed = listValueBluffs({
    node: after.currentNode ?? node,
    equityHands,
    threshold: equityThreshold,
    equityCompare: "lt",
    nodeValues: after.nodeValues,
    evDisplayBasis: after.evDisplayBasis,
  });

  // Re-sort if caller asked for EV/equity (listValueBluffs defaults to betFreq).
  const sorted =
    sortBy === "betFreq"
      ? listed
      : [...listed].sort((left, right) => {
          const leftVal = sortBy === "ev" ? left.ev : left.equity;
          const rightVal = sortBy === "ev" ? right.ev : right.equity;
          const leftOk = leftVal != null && Number.isFinite(leftVal);
          const rightOk = rightVal != null && Number.isFinite(rightVal);
          if (!leftOk && !rightOk) return left.combo.localeCompare(right.combo);
          if (!leftOk) return 1;
          if (!rightOk) return -1;
          const delta = (rightVal as number) - (leftVal as number);
          return delta !== 0 ? delta : left.combo.localeCompare(right.combo);
        });

  const rows = sorted.slice(0, limit).map((row) => ({
    combo: row.combo,
    betFreq: row.betFreq,
    ev: row.ev,
    equity: row.equity,
    topBetAction: row.topBetAction,
    reach: row.reach,
  }));

  if (!analysisPayloadReady(after.nodeValues, after.solutionId, node.node_id)) {
    if (!absences.some((line) => /Action EV/i.test(line))) {
      absences.push("Action EV missing — EV column is null for listed hands.");
    }
  }

  return {
    ok: rows.length > 0,
    seat,
    nodeId: node.node_id,
    line: node.line ?? node.node_id,
    path,
    equityThreshold,
    sortBy,
    rows,
    truncated: sorted.length > rows.length,
    navigated,
    hops,
    absences:
      rows.length > 0
        ? absences
        : [
            ...absences,
            `No bluff candidates for ${seat} at this node (equity < ${equityThreshold}, min bet freq / reach filters).`,
          ],
  };
}

export async function querySelectedHandAnalysis(
  host: StudyEvidenceHost,
  _args: Record<string, unknown> = {},
): Promise<SelectedHandEvidence> {
  const live = host.read();
  const label = live.selectedCell?.text?.trim() || null;
  const absences: string[] = [];
  if (!label) {
    return {
      ok: false,
      label: null,
      nodeId: live.currentNode?.node_id ?? null,
      strategy: null,
      mixedEv: null,
      equity: null,
      evBasis: null,
      absences: ["No hand selected in the Study matrix."],
    };
  }
  const node = live.currentNode;
  if (!node?.node_id) {
    return {
      ok: false,
      label,
      nodeId: null,
      strategy: null,
      mixedEv: null,
      equity: null,
      evBasis: live.evDisplayBasis,
      absences: [`Selected hand ${label}: no Study node — strategy frequencies are missing.`],
    };
  }

  const waitAbsences = await waitForAnalysis(host, { values: true, equity: true });
  absences.push(...waitAbsences);
  const after = host.read();
  const liveNode = after.currentNode ?? node;
  let strategy: SelectedHandEvidence["strategy"] = null;
  if (!liveNode.strategy || !liveNode.reach_defined) {
    absences.push(
      `Selected hand ${label}: strategy frequencies are not loaded for this node.`,
    );
  } else {
    const cell = groupHands(liveNode).find((entry) => entry.text === label);
    if (!cell || !cell.defined || cell.marginalSum <= 0) {
      absences.push(`Selected hand ${label}: no matching strategy mass at this node.`);
    } else {
      const actions = liveNode.actions ?? [];
      strategy = actions.map((action, index) => ({
        action,
        frequency: cell.actionMass[index] / cell.marginalSum,
      }));
    }
  }

  let mixedEv: number | null = null;
  if (analysisPayloadReady(after.nodeValues, after.solutionId, liveNode.node_id)) {
    const cell = groupHands(liveNode).find((entry) => entry.text === label);
    const ev = cell
      ? groupEv(liveNode, after.nodeValues, cell, after.evDisplayBasis)
      : null;
    mixedEv = ev?.mixed ?? null;
    if (mixedEv == null) {
      absences.push(`Selected hand ${label}: action EV evidence is missing for this node.`);
    }
  } else if (!absences.some((line) => /Action EV/i.test(line))) {
    absences.push(
      `Selected hand ${label}: action EV evidence is missing (not calculated or still pending).`,
    );
  }

  let equity: number | null = null;
  const hands = equityHandsForNode(after.equity, liveNode.player);
  if (hands?.length) {
    const cell = groupHands(liveNode).find((entry) => entry.text === label);
    equity = cell
      ? groupEquity(cell, equityByCombo(hands), liveNode)
      : null;
    if (equity == null) {
      absences.push(`Selected hand ${label}: equity evidence is missing for this cell.`);
    }
  } else if (!absences.some((line) => /Equity/i.test(line))) {
    absences.push(`Selected hand ${label}: equity evidence is missing.`);
  }

  return {
    ok: strategy != null || mixedEv != null || equity != null,
    label,
    nodeId: liveNode.node_id,
    strategy,
    mixedEv,
    equity,
    evBasis: after.evDisplayBasis,
    absences,
  };
}

export async function executeStudyEvidenceTool(
  host: StudyEvidenceHost,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  switch (name) {
    case QUERY_NODE_STRATEGY_TOOL.name:
      return queryNodeStrategy(host, args);
    case LIST_BLUFF_CANDIDATES_TOOL.name:
      return listBluffCandidates(host, args);
    case QUERY_SELECTED_HAND_TOOL.name:
      return querySelectedHandAnalysis(host, args);
    default:
      return {
        ok: false,
        absences: [`Unknown or disallowed evidence tool: ${name}`],
      };
  }
}

/** Heuristic: question is about live Study node strategy / bluffs / hand EV. */
export function looksLikeStudyEvidenceRequest(text: string): boolean {
  const lower = text.trim().toLowerCase();
  if (!lower) return false;
  return (
    /\bbluffs?\b/.test(lower) ||
    /\b(value\s*\/?\s*bluffs?|betting\s+range)\b/.test(lower) ||
    /\b(action\s+)?(mix|frequenc(?:y|ies)|strategy)\b/.test(lower) ||
    /\b(how\s+often|what\s+does\s+\w+\s+do)\b/.test(lower) ||
    /\b(selected\s+hand|this\s+hand|combo)\b.*\b(ev|equity|strateg)/.test(lower) ||
    /\b(nash|convergence|nashconv|accuracy)\b/.test(lower) ||
    /\b(current\s+node|to[\s-]?act|to[\s-]?call)\b/.test(lower)
  );
}
