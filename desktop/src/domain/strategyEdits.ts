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

export {
  formatProbPct,
  normalizeProbs,
  seedProbsFromStrategy,
  toggleHandIndex,
};
