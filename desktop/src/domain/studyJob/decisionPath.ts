/**
 * Walk a solved Study node tree along recorded action labels.
 */
import type { NodeActionChild, NodePayload, TreePreviewNode } from "../types";

function childLabel(child: NodeActionChild | string): string | null {
  if (typeof child === "string") return child;
  return child.label ?? child.action ?? null;
}

function childNodeId(child: NodeActionChild | string): string | null {
  if (typeof child === "string") return null;
  return child.node_id ?? null;
}

/** Match canonical engine labels (exact, then case-insensitive). */
export function labelsMatch(expected: string, actual: string): boolean {
  const a = expected.trim();
  const b = actual.trim();
  if (a === b) return true;
  return a.toLowerCase() === b.toLowerCase();
}

export interface DecisionWalkStep {
  label: string;
  from_node_id: string;
  to_node_id: string;
}

export interface DecisionWalkResult {
  ok: true;
  node_id: string;
  steps: DecisionWalkStep[];
}

export interface DecisionWalkFailure {
  ok: false;
  reason: string;
  at_node_id: string;
  remaining: string[];
  legal?: string[];
}

/**
 * Follow recorded actions from `start` using live NodePayload children.
 * Chance children are not expected on a pure river (no board deals left).
 */
export function walkDecisionActions(
  start: NodePayload,
  actions: string[],
  fetchNode: (nodeId: string) => Promise<NodePayload>,
): Promise<DecisionWalkResult | DecisionWalkFailure> {
  return (async () => {
    let current = start;
    const steps: DecisionWalkStep[] = [];
    const remaining = [...actions];

    while (remaining.length > 0) {
      const want = remaining[0];
      if (current.kind === "terminal") {
        return {
          ok: false,
          reason: `terminal before action ${want}`,
          at_node_id: current.node_id,
          remaining: [...remaining],
        };
      }
      const children = current.children ?? [];
      const legal = children
        .map((c) => childLabel(c as NodeActionChild))
        .filter((x): x is string => !!x);
      const match = children.find((c) => {
        const label = childLabel(c as NodeActionChild);
        return label != null && labelsMatch(want, label);
      });
      if (!match) {
        return {
          ok: false,
          reason: `no child matching ${want}`,
          at_node_id: current.node_id,
          remaining: [...remaining],
          legal,
        };
      }
      const nextId = childNodeId(match as NodeActionChild);
      if (!nextId) {
        return {
          ok: false,
          reason: `child ${want} missing node_id`,
          at_node_id: current.node_id,
          remaining: [...remaining],
          legal,
        };
      }
      steps.push({
        label: want,
        from_node_id: current.node_id,
        to_node_id: nextId,
      });
      remaining.shift();
      current = await fetchNode(nextId);
    }
    return { ok: true, node_id: current.node_id, steps };
  })();
}

/**
 * Locate the preview-tree node index after following action labels from root.
 * Used so Build/CLI plan can report the same legal actions along the line.
 */
export function walkPreviewActions(
  nodes: TreePreviewNode[],
  actions: string[],
): { ok: true; nodeIndex: number; legal: string[] } | { ok: false; reason: string; nodeIndex: number; legal: string[] } {
  if (!nodes.length) {
    return { ok: false, reason: "empty preview", nodeIndex: 0, legal: [] };
  }
  let index = 0;
  for (const want of actions) {
    let node = nodes[index];
    if (!node) {
      return { ok: false, reason: "missing node", nodeIndex: index, legal: [] };
    }
    // Skip chance nodes (should not appear on river-only trees).
    let guard = 0;
    while (node.chance && !node.terminal && guard < nodes.length + 2) {
      if (node.chance_child < 0) break;
      index = node.chance_child;
      node = nodes[index];
      guard += 1;
    }
    if (!node || node.terminal) {
      return {
        ok: false,
        reason: `terminal/chance before ${want}`,
        nodeIndex: index,
        legal: [],
      };
    }
    const legal = node.actions.map((a) => a.label);
    const hit = node.actions.find((a) => labelsMatch(want, a.label));
    if (!hit) {
      return { ok: false, reason: `no child matching ${want}`, nodeIndex: index, legal };
    }
    index = hit.child_index;
  }
  const end = nodes[index];
  let node = end;
  let guard = 0;
  while (node?.chance && !node.terminal && guard < nodes.length + 2) {
    if (node.chance_child < 0) break;
    index = node.chance_child;
    node = nodes[index];
    guard += 1;
  }
  const legal = node && !node.terminal && !node.chance ? node.actions.map((a) => a.label) : [];
  return { ok: true, nodeIndex: index, legal };
}
