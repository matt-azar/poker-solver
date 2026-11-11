/**
 * Bounded Study-page evidence tools for the floating assistant.
 *
 * Strategy / bluff listing / selected-hand summary stay read-only at the
 * **current** Study decision. `compare_runouts` is an ordinary Study action:
 * it opens Compare runouts with structured filters and may open a matched
 * row via the same path as a manual report click. Never starts a solve or
 * opens the filesystem.
 */
import {
  actorLabel,
  nextChoicesFromNode,
  strategyFrequencies,
  type PathStep,
} from "../actionHistory";
import {
  isCardRank,
  isCardSuit,
  lineCardReportStreet,
  resolveLineCardAction,
  type LineCardCardPredicate,
  type LineCardReportActiveFilter,
  type LineCardReportModel,
  type LineCardSortBy,
  type LineCardSortDirection,
} from "../lineCardReport";
import { normalizeBoardCards, type CardRank, type CardSuit } from "../cards";
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
  MIN_VALUE_BLUFFS_BET_FREQ,
  MIN_VALUE_BLUFFS_REACH_MASS,
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
   * Optional navigation hook kept for callers/tests. Read-only evidence tools
   * do **not** call it — the player chooses branches in Study.
   */
  navigateTo: (nodeId: string) => Promise<void>;
  /** Optional peek without changing Study selection (engine getNode). */
  fetchNode?: (nodeId: string) => Promise<NodePayload>;
  /** Open Compare runouts for the current decision (optional filter). */
  loadLineCardReport?: (opts?: {
    filter?: LineCardReportActiveFilter | null;
  }) => Promise<void>;
  /** Apply/clear filter on the loaded report without rebuilding rows. */
  applyLineCardReportFilter?: (
    filter: LineCardReportActiveFilter | null,
  ) => void;
  /** Same navigation as a manual Compare-runouts cell click. */
  openLineCardRow?: (resolvedNodeId: string) => Promise<void>;
  /** Read the loaded Compare-runouts report (after load). */
  readLineCardReport?: () => LineCardReportModel | null;
}

export const QUERY_NODE_STRATEGY_TOOL = {
  name: "query_node_strategy",
  description:
    "Read-only posterior action mix for IP or OOP at the **current** Study decision. Does not navigate Study or start a solve. If the selected node is not that seat to act, returns an absence (and a short path hint when peek is available).",
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
    "List betting **bluff candidates** for IP or OOP at the **current** Study decision: combo, bet frequency, EV when loaded, node equity when loaded. Default filter matches Study Value/Bluffs (node equity < 30%, min bet freq / reach). Does not navigate Study or start a solve. For After-call equity, point the player to the Study Value/Bluffs panel.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      seat: {
        type: "string",
        enum: ["IP", "OOP"],
        description: "Seat to list bluff candidates for. Defaults to the acting seat.",
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
          "Exclusive node-equity upper bound for bluff candidates (default 0.30, same as Study Value/Bluffs).",
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
    "Read-only summary of the currently selected matrix hand at the current decision: strategy frequencies, mixed EV, per-action EV when loaded, and equity when loaded. Does not start a solve, fetch runouts, or compare scenarios.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
} as const;

export const COMPARE_RUNOUTS_TOOL = {
  name: "compare_runouts",
  description:
    "Study action: open Compare runouts on the **current** betting line with structured card filters and rank by an action frequency already on the report (e.g. heart rivers that do not pair the board, ranked by IP's 75% bet). Checks solution, board, and source decision. Wrong seat or size returns a path hint or the supported actions — it does not silently hop. Optional openCard uses the same navigation as a manual report click. EV ranking is not available yet.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      seat: {
        type: "string",
        enum: ["IP", "OOP"],
        description: "Acting seat that must match the current decision (default: current actor).",
      },
      street: {
        type: "string",
        enum: ["turn", "river"],
        description: "Card street to vary. Defaults from the current board.",
      },
      suits: {
        type: "array",
        items: { type: "string", enum: ["s", "h", "d", "c"] },
        description: "Keep only these suits (h=hearts). Omit for any suit.",
      },
      ranks: {
        type: "array",
        items: {
          type: "string",
          enum: ["A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2"],
        },
        description: "Keep only these ranks. Omit for any rank.",
      },
      excludeBoardPair: {
        type: "boolean",
        description: "When true, drop cards whose rank pairs the fixed board.",
      },
      action: {
        type: "string",
        description:
          'Action to rank by frequency — exact label ("Bet 75") or size ("75%", "75"). Required when sortBy is frequency.',
      },
      sortBy: {
        type: "string",
        enum: ["frequency", "deal"],
        description: "Sort key (default frequency). EV ranking is a follow-up.",
      },
      sortDirection: {
        type: "string",
        enum: ["desc", "asc"],
        description: "Sort direction (default desc).",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 52,
        description: "Max ranked rows to return (default 12).",
      },
      openCard: {
        type: "string",
        description:
          "Optional card code (e.g. Ah) to open via the same path as a manual report click.",
      },
      openReport: {
        type: "boolean",
        description: "Open Compare runouts with filters (default true).",
      },
    },
  },
} as const;

/** Tools the model may invoke for Study evidence (bounded). */
export const STUDY_EVIDENCE_TOOL_SCHEMAS = [
  QUERY_NODE_STRATEGY_TOOL,
  LIST_BLUFF_CANDIDATES_TOOL,
  QUERY_SELECTED_HAND_TOOL,
  COMPARE_RUNOUTS_TOOL,
] as const;

export const STUDY_EVIDENCE_DEFERRED_TOOLS = [
  "compare_baseline_scenario",
] as const;

export const ASSISTANT_COMPARE_RUNOUTS_LIMITS = {
  maxRows: 52,
  defaultRows: 12,
} as const;

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
  /** Always false in this pass — evidence never mutates Study selection. */
  navigated: boolean;
  hops: number;
  absences: string[];
  /** Optional peeked path tip when the current node is the wrong seat. */
  pathHint?: string | null;
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
  minBetFreq: number;
  minReach: number;
  /** Assistant bluffs use node equity — not Study "After call". */
  equityMode: "node";
  sortBy: ValueBluffsSortKey;
  rows: BluffCandidateRow[];
  truncated: boolean;
  navigated: boolean;
  hops: number;
  absences: string[];
  pathHint?: string | null;
}

export interface SelectedHandEvidence {
  ok: boolean;
  label: string | null;
  nodeId: string | null;
  strategy: Array<{ action: string; frequency: number }> | null;
  mixedEv: number | null;
  /** Per-action EV for comparing two actions (same units / basis as mixedEv). */
  actionEv: Array<{ action: string; ev: number }> | null;
  equity: number | null;
  evBasis: EvDisplayBasis | null;
  absences: string[];
}

export interface CompareRunoutsRow {
  card: string;
  frequency: number | null;
  dealProbability: number | null;
  resolvedNodeId: string | null;
  reach: number | null;
}

export interface CompareRunoutsEvidence {
  ok: boolean;
  seat: StudyEvidenceSeat | null;
  nodeId: string | null;
  line: string | null;
  street: "turn" | "river" | null;
  board: string[];
  filters: {
    suits: CardSuit[];
    ranks: CardRank[];
    excludeBoardPair: boolean;
    action: string | null;
    sortBy: LineCardSortBy;
    sortDirection: LineCardSortDirection;
  };
  supportedActions: string[];
  rows: CompareRunoutsRow[];
  truncated: boolean;
  openedReport: boolean;
  openedCard: string | null;
  /** Prefer for an Open in Study control when a row was (or can be) opened. */
  openInStudy: {
    card: string;
    resolvedNodeId: string;
  } | null;
  absences: string[];
  pathHint?: string | null;
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
 * Prefer passive lines (Check, then Call) when suggesting a nearby seat decision.
 * Used only for path hints — never navigates Study.
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
      return { nodeId: choice.nodeId as string, rank, label: choice.label };
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
 * Peeks via fetchNode only — never changes Study selection.
 */
export async function findSeatDecisionNodeId(
  host: StudyEvidenceHost,
  seat: StudyEvidenceSeat,
  maxHops = ASSISTANT_EVIDENCE_LIMITS.maxNavHops,
): Promise<{ nodeId: string; hops: number; labels: string[] } | { absence: string }> {
  const start = host.read().currentNode;
  if (!start?.node_id) {
    return { absence: "No Study node selected — cannot read strategy." };
  }
  if (start.kind === "decision" && seatMatches(start, seat)) {
    return { nodeId: start.node_id, hops: 0, labels: [] };
  }

  if (!host.fetchNode) {
    const choices = nextChoicesFromNode(start);
    const preferred = preferredChildIds(start)[0];
    if (!preferred || maxHops < 1) {
      return {
        absence: `Current node is not ${seat} to act. Open a ${seat} decision in Study.`,
      };
    }
    const label =
      choices.find((choice) => choice.nodeId === preferred)?.label ?? preferred;
    return { nodeId: preferred, hops: 1, labels: [label] };
  }

  type QueueEntry = { nodeId: string; hops: number; labels: string[] };
  const queue: QueueEntry[] = [{ nodeId: start.node_id, hops: 0, labels: [] }];
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
      return { nodeId: node.node_id, hops: current.hops, labels: current.labels };
    }
    if (current.hops >= maxHops) {
      continue;
    }
    const choices = nextChoicesFromNode(node);
    for (const childId of preferredChildIds(node)) {
      if (visited.has(childId)) continue;
      visited.add(childId);
      const label =
        choices.find((choice) => choice.nodeId === childId)?.label ?? childId;
      queue.push({
        nodeId: childId,
        hops: current.hops + 1,
        labels: [...current.labels, label],
      });
    }
  }

  return {
    absence: `No ${seat} decision node within ${maxHops} hops of the current Study node. Open that decision in Study.`,
  };
}

/**
 * Resolve evidence against the **current** decision only. Never navigates.
 * When the seat does not match, return absences (+ optional path hint).
 */
async function resolveCurrentSeatNode(
  host: StudyEvidenceHost,
  seat: StudyEvidenceSeat,
): Promise<{
  node: NodePayload;
  path: string[];
  pathHint: string | null;
} | { absences: string[]; pathHint: string | null }> {
  const live = host.read();
  const node = live.currentNode;
  const path = pathLabels(live.pathTrail);
  if (!node?.node_id) {
    return {
      absences: ["No Study node selected — open a decision in Study."],
      pathHint: null,
    };
  }
  if (node.kind !== "decision") {
    return {
      absences: [
        `Current Study node ${node.node_id} is a ${node.kind ?? "non-decision"} node. Open a decision for action evidence.`,
      ],
      pathHint: null,
    };
  }
  if (seatMatches(node, seat)) {
    return { node, path, pathHint: null };
  }

  const found = await findSeatDecisionNodeId(host, seat);
  let pathHint: string | null = null;
  if ("nodeId" in found) {
    const via =
      found.labels.length > 0 ? found.labels.join(" → ") : found.nodeId;
    pathHint = `Nearest ${seat} decision within ${found.hops} hop${found.hops === 1 ? "" : "s"}: ${via}. Open it in Study (assistant does not change selection).`;
  }
  return {
    absences: [
      `Current Study node is ${actorLabel(node.to_act, node.player)} to act, not ${seat}. Open the intended ${seat} decision in Study.`,
      ...(pathHint ? [pathHint] : []),
    ],
    pathHint,
  };
}

async function waitForAnalysis(
  host: StudyEvidenceHost,
  needs: { values?: boolean; equity?: boolean },
): Promise<{ absences: string[]; stale: boolean }> {
  const absences: string[] = [];
  const state0 = host.read();
  if (!state0.solutionId || !state0.currentNode?.node_id) {
    return {
      absences: ["No published solution/node — analysis cannot be fetched."],
      stale: false,
    };
  }
  const nodeId = state0.currentNode.node_id;
  const solutionId = state0.solutionId;
  await host.ensureNodeAnalysis();
  {
    const afterEnsure = host.read();
    if (
      afterEnsure.currentNode?.node_id !== nodeId ||
      afterEnsure.solutionId !== solutionId
    ) {
      return {
        absences: [
          "Study solution or decision changed while waiting for analysis. Retry on the intended decision.",
        ],
        stale: true,
      };
    }
  }
  const deadline = Date.now() + ASSISTANT_EVIDENCE_LIMITS.analysisWaitMs;

  while (Date.now() < deadline) {
    const live = host.read();
    if (live.currentNode?.node_id !== nodeId || live.solutionId !== solutionId) {
      return {
        absences: [
          "Study solution or decision changed while waiting for analysis. Retry on the intended decision.",
        ],
        stale: true,
      };
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
      return { absences, stale: false };
    }
    if (valuesOk && equityOk) {
      return { absences: [], stale: false };
    }
    await sleep(ASSISTANT_EVIDENCE_LIMITS.pollIntervalMs);
  }

  const live = host.read();
  if (live.currentNode?.node_id !== nodeId || live.solutionId !== solutionId) {
    return {
      absences: [
        "Study solution or decision changed while waiting for analysis. Retry on the intended decision.",
      ],
      stale: true,
    };
  }
  if (needs.values && !analysisPayloadReady(live.nodeValues, solutionId, nodeId)) {
    absences.push("Action EV did not become ready within the assistant wait budget.");
  }
  if (needs.equity && !analysisPayloadReady(live.equity, solutionId, nodeId)) {
    absences.push("Equity did not become ready within the assistant wait budget.");
  }
  return { absences, stale: false };
}

function identityStillMatches(
  host: StudyEvidenceHost,
  solutionId: string,
  nodeId: string,
): boolean {
  const live = host.read();
  return live.solutionId === solutionId && live.currentNode?.node_id === nodeId;
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

  const resolved = await resolveCurrentSeatNode(host, seat);
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
      pathHint: resolved.pathHint,
    };
  }

  const { node, path, pathHint } = resolved;
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
      navigated: false,
      hops: 0,
      absences,
      pathHint,
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
    navigated: false,
    hops: 0,
    absences,
    pathHint,
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
  const minBetFreq = MIN_VALUE_BLUFFS_BET_FREQ;
  const minReach = MIN_VALUE_BLUFFS_REACH_MASS;

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
    minBetFreq,
    minReach,
    equityMode: "node",
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

  const resolved = await resolveCurrentSeatNode(host, seat);
  if ("absences" in resolved) {
    return empty(resolved.absences, { pathHint: resolved.pathHint });
  }

  const { node, path, pathHint } = resolved;
  const solutionId = live.solutionId;
  const nodeId = node.node_id;
  if (!node.strategy || !node.reach_defined) {
    return empty(
      [`Strategy frequencies are not loaded for node ${node.node_id}.`],
      { nodeId: node.node_id, line: node.line ?? node.node_id, path, pathHint },
    );
  }

  const waited = await waitForAnalysis(host, { values: true, equity: true });
  if (waited.stale || !identityStillMatches(host, solutionId, nodeId)) {
    return empty([
      "Study solution or decision changed while gathering bluff candidates. Retry on the intended decision.",
    ]);
  }

  const after = host.read();
  const liveNode = after.currentNode;
  if (!liveNode?.node_id || liveNode.node_id !== nodeId) {
    return empty([
      "Study decision changed while gathering bluff candidates. Retry on the intended decision.",
    ]);
  }

  const equityHandsRaw = equityHandsForNode(after.equity, liveNode.player);
  const absences = [...waited.absences];
  if (!equityHandsRaw?.length) {
    absences.push(
      "Equity hands are missing for the acting seat — cannot classify bluff candidates vs the equity threshold.",
    );
    return empty(absences, {
      nodeId: liveNode.node_id,
      line: liveNode.line ?? liveNode.node_id,
      path,
      pathHint,
    });
  }
  const equityHands = equityHandsRaw.map((hand) => ({
    combo: hand.combo,
    equity: Number(hand.equity),
    weight: Number(hand.weight ?? 0),
  }));

  const listed = listValueBluffs({
    node: liveNode,
    equityHands,
    threshold: equityThreshold,
    equityCompare: "lt",
    minBetFreq,
    minReachMass: minReach,
    nodeValues: after.nodeValues,
    evDisplayBasis: after.evDisplayBasis,
  });

  if (!identityStillMatches(host, solutionId, nodeId)) {
    return empty([
      "Study solution or decision changed while gathering bluff candidates. Retry on the intended decision.",
    ]);
  }

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

  if (!analysisPayloadReady(after.nodeValues, after.solutionId, liveNode.node_id)) {
    if (!absences.some((line) => /Action EV/i.test(line))) {
      absences.push("Action EV missing — EV column is null for listed hands.");
    }
  }

  absences.push(
    "Bluff candidates use node equity. For After-call equity, open Study → Value / Bluffs and switch the equity mode.",
  );

  return {
    ok: rows.length > 0,
    seat,
    nodeId: liveNode.node_id,
    line: liveNode.line ?? liveNode.node_id,
    path,
    equityThreshold,
    minBetFreq,
    minReach,
    equityMode: "node",
    sortBy,
    rows,
    truncated: sorted.length > rows.length,
    navigated: false,
    hops: 0,
    pathHint,
    absences:
      rows.length > 0
        ? absences
        : [
            ...absences,
            `No bluff candidates for ${seat} at this node (node equity < ${equityThreshold}, min bet freq ${minBetFreq}, min reach ${minReach}).`,
          ],
  };
}

function parseSuitList(raw: unknown): CardSuit[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: CardSuit[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const suit = entry.trim().toLowerCase();
    if (isCardSuit(suit) && !out.includes(suit)) {
      out.push(suit);
    }
  }
  return out;
}

function parseRankList(raw: unknown): CardRank[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: CardRank[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const rank = entry.trim().toUpperCase();
    if (isCardRank(rank) && !out.includes(rank)) {
      out.push(rank);
    }
  }
  return out;
}

/**
 * Open Compare runouts with structured filters and optional row navigation.
 * Requires a published solution and a turn/river decision whose seat matches.
 */
export async function compareRunouts(
  host: StudyEvidenceHost,
  args: Record<string, unknown> = {},
): Promise<CompareRunoutsEvidence> {
  const live = host.read();
  const seat = normalizeSeat(args.seat, actingSeat(live.currentNode));
  const suits = parseSuitList(args.suits);
  const ranks = parseRankList(args.ranks);
  const excludeBoardPair = Boolean(args.excludeBoardPair);
  const sortByRaw = typeof args.sortBy === "string" ? args.sortBy : "frequency";
  const sortBy: LineCardSortBy =
    sortByRaw === "deal" || sortByRaw === "frequency" ? sortByRaw : "frequency";
  const sortDirection: LineCardSortDirection =
    args.sortDirection === "asc" ? "asc" : "desc";
  const limitRaw =
    typeof args.limit === "number" && Number.isFinite(args.limit)
      ? Math.trunc(args.limit)
      : ASSISTANT_COMPARE_RUNOUTS_LIMITS.defaultRows;
  const limit = Math.min(
    ASSISTANT_COMPARE_RUNOUTS_LIMITS.maxRows,
    Math.max(1, limitRaw),
  );
  const openReport = args.openReport !== false;
  const openCard =
    typeof args.openCard === "string" && args.openCard.trim()
      ? args.openCard.trim()
      : null;
  const actionQuery =
    typeof args.action === "string" && args.action.trim()
      ? args.action.trim()
      : null;

  const empty = (
    absences: string[],
    partial?: Partial<CompareRunoutsEvidence>,
  ): CompareRunoutsEvidence => ({
    ok: false,
    seat,
    nodeId: live.currentNode?.node_id ?? null,
    line: live.currentNode?.line ?? null,
    street: null,
    board: normalizeBoardCards(live.currentNode?.board),
    filters: {
      suits,
      ranks,
      excludeBoardPair,
      action: actionQuery,
      sortBy,
      sortDirection,
    },
    supportedActions: [...(live.currentNode?.actions ?? [])],
    rows: [],
    truncated: false,
    openedReport: false,
    openedCard: null,
    openInStudy: null,
    absences,
    ...partial,
  });

  if (!seat) {
    return empty([
      "Could not determine seat (IP/OOP). Pass seat explicitly or open a decision node.",
    ]);
  }
  if (!live.solutionId) {
    return empty([
      "No published solution — open or solve a spot before Compare runouts.",
    ]);
  }
  if (!host.loadLineCardReport || !host.readLineCardReport) {
    return empty([
      "Compare runouts is not wired in this assistant host. Open Compare runouts from Study.",
    ]);
  }

  const resolved = await resolveCurrentSeatNode(host, seat);
  if ("absences" in resolved) {
    return empty(resolved.absences, { pathHint: resolved.pathHint });
  }

  const { node, pathHint } = resolved;
  const solutionId = live.solutionId;
  const nodeId = node.node_id;
  const board = normalizeBoardCards(node.board);
  const streetFromBoard = lineCardReportStreet(board);
  const streetArg =
    args.street === "turn" || args.street === "river" ? args.street : null;
  if (!streetFromBoard) {
    return empty(
      [
        "Compare runouts needs a turn or river board (flop-only spots have no card to vary).",
      ],
      {
        nodeId,
        line: node.line ?? nodeId,
        supportedActions: [...(node.actions ?? [])],
        pathHint,
      },
    );
  }
  if (streetArg && streetArg !== streetFromBoard) {
    return empty(
      [
        `Current board varies the ${streetFromBoard}, not the ${streetArg}. Open a ${streetArg} decision on this line in Study.`,
      ],
      {
        nodeId,
        line: node.line ?? nodeId,
        street: streetFromBoard,
        board,
        supportedActions: [...(node.actions ?? [])],
        pathHint,
      },
    );
  }
  const street = streetFromBoard;
  const actionLabels = [...(node.actions ?? [])];
  let actionIndex: number | null = null;
  let actionLabel: string | null = null;
  if (sortBy === "frequency") {
    const matched = resolveLineCardAction(actionLabels, actionQuery);
    if (!matched.ok) {
      return empty([matched.reason], {
        nodeId,
        line: node.line ?? nodeId,
        street,
        board,
        supportedActions: matched.supported,
        pathHint,
      });
    }
    actionIndex = matched.index;
    actionLabel = matched.label;
  }

  const predicate: LineCardCardPredicate = {
    ...(suits.length ? { suits } : {}),
    ...(ranks.length ? { ranks } : {}),
    ...(excludeBoardPair ? { excludeBoardPair: true } : {}),
  };
  const filter: LineCardReportActiveFilter = {
    predicate,
    board,
    actionIndex,
    actionLabel,
    sortBy,
    sortDirection,
    seat,
  };

  if (!identityStillMatches(host, solutionId, nodeId)) {
    return empty([
      "Study solution or decision changed before Compare runouts started. Retry on the intended decision.",
    ]);
  }

  if (openReport) {
    await host.loadLineCardReport({ filter });
  } else if (host.applyLineCardReportFilter) {
    const existing = host.readLineCardReport();
    if (
      existing &&
      !existing.pending &&
      existing.solutionId === solutionId &&
      existing.reportNodeId === nodeId
    ) {
      host.applyLineCardReportFilter(filter);
    } else {
      await host.loadLineCardReport({ filter });
    }
  } else {
    await host.loadLineCardReport({ filter });
  }

  if (!identityStillMatches(host, solutionId, nodeId)) {
    return empty([
      "Study solution or decision changed while building Compare runouts. Retry on the intended decision.",
    ]);
  }

  const report = host.readLineCardReport();
  if (!report || report.pending) {
    return empty(
      [
        report?.error ??
          "Compare runouts did not finish loading. Retry from the current decision.",
      ],
      {
        nodeId,
        line: node.line ?? nodeId,
        street,
        board,
        supportedActions: actionLabels,
        pathHint,
      },
    );
  }
  if (report.error) {
    return empty([report.error], {
      nodeId,
      line: report.line,
      street: report.street,
      board,
      supportedActions: [...report.actionLabels],
      pathHint,
    });
  }
  if (report.solutionId !== solutionId || report.reportNodeId !== nodeId) {
    return empty([
      "Compare runouts report identity no longer matches the current Study decision. Retry on the intended decision.",
    ]);
  }

  const matchedCards = report.matchedCards ?? [];
  const byCard = new Map(report.rows.map((row) => [row.card, row]));
  const ranked: CompareRunoutsRow[] = [];
  for (const card of matchedCards) {
    const row = byCard.get(card);
    if (!row) continue;
    ranked.push({
      card: row.card,
      frequency:
        actionIndex != null && row.frequencies[actionIndex] != null
          ? row.frequencies[actionIndex]!
          : null,
      dealProbability: row.dealProbability,
      resolvedNodeId: row.resolvedNodeId,
      reach: row.reach,
    });
  }

  const rows = ranked.slice(0, limit);
  const absences: string[] = [];
  if (rows.length === 0) {
    absences.push(
      "No runouts matched those filters on this line. Adjust suits/ranks/board-pair or open another decision.",
    );
  }

  let openedCard: string | null = null;
  let openInStudy: CompareRunoutsEvidence["openInStudy"] = null;
  const topOpenable = rows.find((row) => row.resolvedNodeId);
  if (topOpenable?.resolvedNodeId) {
    openInStudy = {
      card: topOpenable.card,
      resolvedNodeId: topOpenable.resolvedNodeId,
    };
  }

  if (openCard) {
    const target =
      ranked.find(
        (row) => row.card.toLowerCase() === openCard.toLowerCase() && row.resolvedNodeId,
      ) ?? null;
    if (!target?.resolvedNodeId) {
      absences.push(
        `Card ${openCard} is not in the filtered Compare runouts results (or has no decision).`,
      );
    } else if (!host.openLineCardRow) {
      absences.push(
        `Card ${openCard} matched, but Open in Study is not wired in this assistant host.`,
      );
      openInStudy = { card: target.card, resolvedNodeId: target.resolvedNodeId };
    } else if (!identityStillMatches(host, solutionId, nodeId)) {
      absences.push(
        "Study solution or decision changed before opening the runout. Retry on the intended decision.",
      );
    } else {
      await host.openLineCardRow(target.resolvedNodeId);
      openedCard = target.card;
      openInStudy = { card: target.card, resolvedNodeId: target.resolvedNodeId };
    }
  }

  return {
    ok: rows.length > 0,
    seat,
    nodeId: report.reportNodeId,
    line: report.line,
    street: report.street,
    board,
    filters: {
      suits,
      ranks,
      excludeBoardPair,
      action: actionLabel,
      sortBy,
      sortDirection,
    },
    supportedActions: [...report.actionLabels],
    rows,
    truncated: ranked.length > rows.length,
    openedReport: openReport || Boolean(report),
    openedCard,
    openInStudy,
    absences,
    pathHint,
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
      actionEv: null,
      equity: null,
      evBasis: null,
      absences: ["No hand selected in the Study matrix. Select the matrix cell first."],
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
      actionEv: null,
      equity: null,
      evBasis: live.evDisplayBasis,
      absences: [`Selected hand ${label}: no Study node — strategy frequencies are missing.`],
    };
  }
  if (node.kind !== "decision") {
    return {
      ok: false,
      label,
      nodeId: node.node_id,
      strategy: null,
      mixedEv: null,
      actionEv: null,
      equity: null,
      evBasis: live.evDisplayBasis,
      absences: [
        `Selected hand ${label}: current node is a ${node.kind ?? "non-decision"} node. Open a decision for action EV.`,
      ],
    };
  }

  const solutionId = live.solutionId;
  const nodeId = node.node_id;
  if (!solutionId) {
    return {
      ok: false,
      label,
      nodeId,
      strategy: null,
      mixedEv: null,
      actionEv: null,
      equity: null,
      evBasis: live.evDisplayBasis,
      absences: [
        "No published solution — selected-hand evidence is unavailable. Solve or open a solution first.",
      ],
    };
  }

  const waited = await waitForAnalysis(host, { values: true, equity: true });
  if (waited.stale || !identityStillMatches(host, solutionId, nodeId)) {
    return {
      ok: false,
      label,
      nodeId,
      strategy: null,
      mixedEv: null,
      actionEv: null,
      equity: null,
      evBasis: live.evDisplayBasis,
      absences: [
        "Study solution or decision changed while reading the selected hand. Retry on the intended decision.",
      ],
    };
  }
  absences.push(...waited.absences);
  const after = host.read();
  const liveNode = after.currentNode;
  if (!liveNode?.node_id || liveNode.node_id !== nodeId) {
    return {
      ok: false,
      label,
      nodeId,
      strategy: null,
      mixedEv: null,
      actionEv: null,
      equity: null,
      evBasis: after.evDisplayBasis,
      absences: [
        "Study decision changed while reading the selected hand. Retry on the intended decision.",
      ],
    };
  }

  let strategy: SelectedHandEvidence["strategy"] = null;
  if (!liveNode.strategy || !liveNode.reach_defined) {
    absences.push(
      `Selected hand ${label}: strategy frequencies are not loaded for this node.`,
    );
  } else {
    const cell = groupHands(liveNode).find((entry) => entry.text === label);
    if (!cell || !cell.defined || cell.marginalSum <= 0) {
      absences.push(
        `Selected hand ${label}: no matching strategy mass at this node. Select its matrix cell.`,
      );
    } else {
      const actions = liveNode.actions ?? [];
      strategy = actions.map((action, index) => ({
        action,
        frequency: cell.actionMass[index] / cell.marginalSum,
      }));
    }
  }

  let mixedEv: number | null = null;
  let actionEv: SelectedHandEvidence["actionEv"] = null;
  if (analysisPayloadReady(after.nodeValues, after.solutionId, liveNode.node_id)) {
    const cell = groupHands(liveNode).find((entry) => entry.text === label);
    const ev = cell
      ? groupEv(liveNode, after.nodeValues, cell, after.evDisplayBasis)
      : null;
    mixedEv = ev?.mixed ?? null;
    if (ev?.action?.length && liveNode.actions?.length) {
      actionEv = liveNode.actions.map((action, index) => ({
        action,
        ev: ev.action[index] ?? 0,
      }));
    }
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

  if (!identityStillMatches(host, solutionId, nodeId)) {
    return {
      ok: false,
      label,
      nodeId,
      strategy: null,
      mixedEv: null,
      actionEv: null,
      equity: null,
      evBasis: after.evDisplayBasis,
      absences: [
        "Study solution or decision changed while reading the selected hand. Retry on the intended decision.",
      ],
    };
  }

  return {
    ok: strategy != null || mixedEv != null || equity != null,
    label,
    nodeId: liveNode.node_id,
    strategy,
    mixedEv,
    actionEv,
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
    case COMPARE_RUNOUTS_TOOL.name:
      return compareRunouts(host, args);
    default:
      return {
        ok: false,
        absences: [`Unknown or disallowed evidence tool: ${name}`],
      };
  }
}

/** Heuristic: Compare-runouts filter/rank request (Fake client routing). */
export function looksLikeCompareRunoutsRequest(text: string): boolean {
  const lower = text.trim().toLowerCase();
  if (!lower) return false;
  if (/\b(compare\s+runouts|filter\s+runouts|rank(?:ed)?\s+by\b.*\bbet)\b/.test(lower)) {
    return true;
  }
  if (
    /\b(heart|spade|diamond|club|hearts|spades|diamonds|clubs)\b/.test(lower) &&
    /\b(river|turn|runouts?|cards?)\b/.test(lower)
  ) {
    return true;
  }
  if (
    /\b(don'?t|do\s+not|doesn'?t)\s+pair\b/.test(lower) &&
    /\b(board|river|turn|runouts?)\b/.test(lower)
  ) {
    return true;
  }
  return false;
}

/** Heuristic: question is about live Study node strategy / bluffs / hand EV / runouts. */
export function looksLikeStudyEvidenceRequest(text: string): boolean {
  const lower = text.trim().toLowerCase();
  if (!lower) return false;
  if (looksLikeCompareRunoutsRequest(text)) {
    return true;
  }
  return (
    /\bbluffs?\b/.test(lower) ||
    /\b(value\s*\/?\s*bluffs?|betting\s+range)\b/.test(lower) ||
    /\b(action\s+)?(mix|frequenc(?:y|ies)|strategy)\b/.test(lower) ||
    /\b(how\s+often|what\s+does\s+\w+\s+do)\b/.test(lower) ||
    /\b(selected\s+hand|this\s+hand|combo)\b.*\b(ev|equity|strateg)/.test(lower) ||
    /\b(why\s+is\s+\w+|a[2-9tjqka]s?\b.*\b(bet|betting|here))\b/.test(lower) ||
    /\b(nash|convergence|nashconv|accuracy)\b/.test(lower) ||
    /\b(current\s+node|to[\s-]?act|to[\s-]?call)\b/.test(lower)
  );
}
