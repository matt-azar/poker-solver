/** Free-form stored-strategy overlays — distinct from LockSet constraints. */

import {
  formatProbPct,
  normalizeProbs,
  seedProbsFromStrategy,
  toggleHandIndex,
  type LockDraft,
} from "./locks";
import {
  classifyEngineSessionFault,
  isEngineSessionDead,
} from "./sessionRecovery";

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

/** True when the IPC session/pipe is dead (Apply must surface Reconnect). */
export function isStrategyEditSessionDead(detail: string): boolean {
  // ZR-123: one session-dead classifier for Study (ZR-119 Apply uses this).
  return isEngineSessionDead(detail);
}

/**
 * Classify Apply / clear failures so recoverable host rejects stay soft and
 * pipe death routes through durable session recovery (ZR-119 + ZR-123).
 */
export function classifyStrategyEditFailure(error: unknown): {
  sessionDead: boolean;
  detail: string;
  message: string;
} {
  const fault = classifyEngineSessionFault(error);
  const detail = fault.detail === "engine fault" ? "Strategy edit failed" : fault.detail;
  if (fault.sessionDead) {
    return {
      sessionDead: true,
      detail,
      message: `Strategy edit failed — engine session died (${detail}). Use Reconnect, then re-open the strategy editor.`,
    };
  }
  return {
    sessionDead: false,
    detail,
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
