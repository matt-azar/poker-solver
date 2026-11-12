/** Free-form stored-strategy overlays — distinct from LockSet constraints. */

import {
  formatProbPct,
  normalizeProbs,
  seedProbsFromStrategy,
  toggleHandIndex,
  type LockDraft,
} from "./locks";

export interface StrategyEditRecord {
  node_id: string;
  infoset_id?: number;
  kind: "full" | "selected";
  hand_indices: number[];
  probs: number[];
}

export interface StrategyEditsPayload {
  edits: StrategyEditRecord[];
  persisted?: boolean;
}

export type StrategyEditDraft = LockDraft;

export function editForNode(
  edits: StrategyEditRecord[],
  nodeId: string,
): StrategyEditRecord | null {
  return edits.find((entry) => entry.node_id === nodeId) ?? null;
}

export function isHandEdited(edit: StrategyEditRecord | null, handIndex: number): boolean {
  if (!edit) {
    return false;
  }
  if (edit.kind === "full") {
    return true;
  }
  return edit.hand_indices.includes(handIndex);
}

/**
 * After a strategy-edit mutation await: write draft/list only when the live
 * solution (+ node for draft) still matches the request scope.
 */
export function strategyMutationCompletion(args: {
  requestSolutionId: string;
  requestNodeId: string;
  liveSolutionId: string | null | undefined;
  liveNodeId: string | null | undefined;
}): { applyEditsList: boolean; applyDraft: boolean; reloadNode: boolean } {
  if (
    !args.liveSolutionId ||
    args.liveSolutionId !== args.requestSolutionId
  ) {
    return { applyEditsList: false, applyDraft: false, reloadNode: false };
  }
  if (!args.liveNodeId || args.liveNodeId !== args.requestNodeId) {
    return { applyEditsList: true, applyDraft: false, reloadNode: false };
  }
  return { applyEditsList: true, applyDraft: true, reloadNode: true };
}

/** True when the IPC session/pipe is dead (Apply must surface Reconnect, not a soft edit failure). */
export function isStrategyEditSessionDead(detail: string): boolean {
  const text = detail.toLowerCase();
  return (
    text.includes("pipe closed") ||
    text.includes("broken pipe") ||
    text.includes("shut down") ||
    text.includes("session killed") ||
    text.includes("session shut down") ||
    text.includes("engine unreachable") ||
    text.includes("invalidframe") ||
    text.includes("invalid_frame") ||
    text.includes("solver-engine exiting") ||
    text.includes("sidecar_exit")
  );
}

/**
 * Classify Apply / clear failures so recoverable host rejects stay soft and
 * pipe death immediately asks for Reconnect (ZR-119).
 */
export function classifyStrategyEditFailure(error: unknown): {
  sessionDead: boolean;
  message: string;
} {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Strategy edit failed";
  const detail = raw.trim() || "Strategy edit failed";
  if (isStrategyEditSessionDead(detail)) {
    return {
      sessionDead: true,
      message: `Strategy edit failed — engine session died (${detail}). Use Reconnect, then re-open the strategy editor.`,
    };
  }
  return {
    sessionDead: false,
    message: detail.startsWith("Strategy edit")
      ? detail
      : `Strategy edit failed: ${detail}`,
  };
}

export {
  formatProbPct,
  normalizeProbs,
  seedProbsFromStrategy,
  toggleHandIndex,
};
