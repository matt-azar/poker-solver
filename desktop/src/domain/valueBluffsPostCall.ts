/**
 * Mode B: resolve Call-child node ids and fetch check-down equity there
 * without navigating the Study path.
 */
import type { EquityHandRow } from "./analysis";
import { equityHandsForNode } from "./matrixDisplay";
import {
  MIN_VALUE_BLUFFS_BET_FREQ,
  callChildIdFromFacing,
  equityHandsForDominantSizes,
  facingChildIdForBet,
  valueBluffsBettingActionIndices,
} from "./valueBluffs";
import type { NodePayload } from "./types";

export interface PostCallEquityResult {
  hands: EquityHandRow[];
  /**
   * Per bet/raise/all-in action index → acting-seat equity at that size's Call
   * child. Used to re-join after-call equity when size toggles change.
   */
  handsByBetAction: Map<number, EquityHandRow[]>;
  /** Call-child node ids that were queried. */
  callNodeIds: string[];
  /** Bet sizes that had no Call child. */
  missingCallCount: number;
  /** Human-readable failure when nothing usable was loaded. */
  error: string | null;
}

export interface PostCallFetchDeps {
  getNode: (solutionId: string, nodeId: string, signal?: AbortSignal) => Promise<NodePayload>;
  getEquity: (
    solutionId: string,
    nodeId: string,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

const POLL_MS = 250;
const MAX_POLLS = 120;

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Poll getEquity until pending clears or abort/timeout. */
export async function pollNodeEquity(
  deps: PostCallFetchDeps,
  solutionId: string,
  nodeId: string,
  signal?: AbortSignal,
): Promise<unknown> {
  for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const body = (await deps.getEquity(solutionId, nodeId, signal)) as {
      pending?: boolean;
    };
    if (!body?.pending) {
      return body;
    }
    await sleep(POLL_MS, signal);
  }
  throw new Error("Timed out waiting for post-call equity");
}

/** Prefer host `value_bluffs_post_call` when deps expose it (IPC Study). */
export type PostCallHostDeps = PostCallFetchDeps & {
  getValueBluffsPostCall?: (
    solutionId: string,
    nodeId: string,
    opts?: { minBetFreq?: number; signal?: AbortSignal },
  ) => Promise<unknown>;
};

function handsByActionFromHost(
  raw: {
    hands_by_action?: Array<{
      action_index?: number;
      hands?: Array<{ combo?: string; equity?: number; weight?: number }>;
    }>;
  },
): Map<number, EquityHandRow[]> {
  const map = new Map<number, EquityHandRow[]>();
  if (!Array.isArray(raw.hands_by_action)) {
    return map;
  }
  for (const entry of raw.hands_by_action) {
    const actionIndex = Number(entry?.action_index);
    if (!Number.isInteger(actionIndex) || actionIndex < 0) {
      continue;
    }
    const hands = Array.isArray(entry?.hands)
      ? entry.hands
          .filter((hand) => hand?.combo)
          .map((hand) => ({
            combo: String(hand.combo),
            equity: Number(hand.equity),
            weight: Number(hand.weight ?? 0),
          }))
      : [];
    map.set(actionIndex, hands);
  }
  return map;
}

function postCallResultFromHostBody(body: unknown): PostCallEquityResult | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const raw = body as {
    pending?: boolean;
    kind?: string;
    hands?: Array<{ combo?: string; equity?: number; weight?: number }>;
    hands_by_action?: Array<{
      action_index?: number;
      hands?: Array<{ combo?: string; equity?: number; weight?: number }>;
    }>;
    call_node_ids?: string[];
    missing_call_count?: number;
    error?: string | null;
  };
  if (raw.pending) {
    return null;
  }
  if (raw.kind && raw.kind !== "value_bluffs_post_call") {
    return null;
  }
  if (!Array.isArray(raw.hands)) {
    return null;
  }
  return {
    hands: raw.hands
      .filter((hand) => hand?.combo)
      .map((hand) => ({
        combo: String(hand.combo),
        equity: Number(hand.equity),
        weight: Number(hand.weight ?? 0),
      })),
    handsByBetAction: handsByActionFromHost(raw),
    callNodeIds: Array.isArray(raw.call_node_ids)
      ? raw.call_node_ids.map(String)
      : [],
    missingCallCount: Number(raw.missing_call_count ?? 0),
    error: raw.error ?? null,
  };
}

/**
 * For each betting size on `node`, walk bet → facing → Call and load
 * check-down equity at the Call child. Returns synthetic acting-seat hands
 * keyed by each combo's max-prob size, plus per-size maps for size filters.
 *
 * Prefers a single host `value_bluffs_post_call` when available.
 */
export async function fetchPostCallEquityHands(args: {
  solutionId: string;
  node: NodePayload;
  heroPlayer: number | null | undefined;
  deps: PostCallHostDeps;
  signal?: AbortSignal;
  minBetFreq?: number;
}): Promise<PostCallEquityResult> {
  const {
    solutionId,
    node,
    heroPlayer,
    deps,
    signal,
    minBetFreq = MIN_VALUE_BLUFFS_BET_FREQ,
  } = args;

  if (deps.getValueBluffsPostCall && node.node_id) {
    try {
      const body = await deps.getValueBluffsPostCall(solutionId, node.node_id, {
        minBetFreq,
        signal,
      });
      const mapped = postCallResultFromHostBody(body);
      if (mapped) {
        return mapped;
      }
    } catch {
      // Fall through to multi-getNode orchestration.
    }
  }

  const actionIndices = valueBluffsBettingActionIndices(node.actions);
  if (!actionIndices.length) {
    return {
      hands: [],
      handsByBetAction: new Map(),
      callNodeIds: [],
      missingCallCount: 0,
      error: "No betting actions with frequency ≥ 1%.",
    };
  }

  const facingCache = new Map<string, NodePayload>();
  const equityCache = new Map<string, unknown>();
  const handsByBetAction = new Map<number, EquityHandRow[] | null>();
  const callNodeIds: string[] = [];
  let missingCallCount = 0;

  for (const actionIndex of actionIndices) {
    const facingId = facingChildIdForBet(node, actionIndex);
    if (!facingId) {
      missingCallCount += 1;
      handsByBetAction.set(actionIndex, null);
      continue;
    }
    let facing = facingCache.get(facingId);
    if (!facing) {
      facing = await deps.getNode(solutionId, facingId, signal);
      facingCache.set(facingId, facing);
    }
    const callId = callChildIdFromFacing(facing);
    if (!callId) {
      missingCallCount += 1;
      handsByBetAction.set(actionIndex, null);
      continue;
    }
    if (!callNodeIds.includes(callId)) {
      callNodeIds.push(callId);
    }
    let equityPayload = equityCache.get(callId);
    if (!equityPayload) {
      equityPayload = await pollNodeEquity(deps, solutionId, callId, signal);
      equityCache.set(callId, equityPayload);
    }
    const rawHands = equityHandsForNode(
      equityPayload as {
        pending?: boolean;
        oop_hands?: EquityHandRow[];
        ip_hands?: EquityHandRow[];
      },
      heroPlayer,
    );
    const hands: EquityHandRow[] | null = rawHands
      ? rawHands.map((hand) => ({
          combo: hand.combo,
          equity: Number(hand.equity),
          weight: Number(hand.weight ?? 0),
        }))
      : null;
    handsByBetAction.set(actionIndex, hands);
  }

  const hands = equityHandsForDominantSizes({
    node,
    handsByBetAction,
    minBetFreq,
  });

  const definedByAction = new Map<number, EquityHandRow[]>();
  for (const [actionIndex, actionHands] of handsByBetAction) {
    if (actionHands?.length) {
      definedByAction.set(actionIndex, actionHands);
    }
  }

  if (!hands.length) {
    return {
      hands,
      handsByBetAction: definedByAction,
      callNodeIds,
      missingCallCount,
      error:
        missingCallCount > 0
          ? "No Call child for the dominant bet/raise size(s)."
          : "Post-call equity unavailable for betting hands.",
    };
  }

  return {
    hands,
    handsByBetAction: definedByAction,
    callNodeIds,
    missingCallCount,
    error: null,
  };
}
