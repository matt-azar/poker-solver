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

export {
  formatProbPct,
  normalizeProbs,
  seedProbsFromStrategy,
  toggleHandIndex,
};
