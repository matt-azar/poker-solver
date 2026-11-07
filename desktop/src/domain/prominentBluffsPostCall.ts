/**
 * Mode B: resolve Call-child node ids and fetch check-down equity there
 * without navigating the Study path.
 */
import type { EquityHandRow } from "./analysis";
import { equityHandsForNode } from "./matrixDisplay";
import {
  MIN_BET_FREQ,
  callChildIdFromFacing,
  dominantBettingActionIndices,
  equityHandsForDominantSizes,
  facingChildIdForBet,
} from "./prominentBluffs";
import type { NodePayload } from "./types";

export interface PostCallEquityResult {
  hands: EquityHandRow[];
  /** Call-child node ids that were queried. */
  callNodeIds: string[];
  /** Dominant bet sizes that had no Call child. */
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

/**
 * For each dominant betting size on `node`, walk bet → facing → Call and load
 * check-down equity at the Call child. Returns synthetic acting-seat hands
 * keyed by each combo's max-prob size.
 */
export async function fetchPostCallEquityHands(args: {
  solutionId: string;
  node: NodePayload;
  heroPlayer: number | null | undefined;
  deps: PostCallFetchDeps;
  signal?: AbortSignal;
  minBetFreq?: number;
}): Promise<PostCallEquityResult> {
  const {
    solutionId,
    node,
    heroPlayer,
    deps,
    signal,
    minBetFreq = MIN_BET_FREQ,
  } = args;

  const actionIndices = dominantBettingActionIndices(node, minBetFreq);
  if (!actionIndices.length) {
    return {
      hands: [],
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

  if (!hands.length) {
    return {
      hands,
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
    callNodeIds,
    missingCallCount,
    error: null,
  };
}
