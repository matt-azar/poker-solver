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

function skipChance(
  nodes: TreePreviewNode[],
  startIndex: number,
): { index: number; node: TreePreviewNode | undefined } {
  let index = startIndex;
  let node = nodes[index];
  let guard = 0;
  while (node?.chance && !node.terminal && guard < nodes.length + 2) {
    if (node.chance_child < 0) break;
    index = node.chance_child;
    node = nodes[index];
    guard += 1;
  }
  return { index, node };
}

/**
 * Locate the preview-tree node index after following action labels from root.
 * Used so Build/CLI plan can report the same legal actions along the line.
 */
export function walkPreviewActions(
  nodes: TreePreviewNode[],
  actions: string[],
): { ok: true; nodeIndex: number; legal: string[] } | { ok: false; reason: string; nodeIndex: number; legal: string[]; missing?: string } {
  if (!nodes.length) {
    return { ok: false, reason: "empty preview", nodeIndex: 0, legal: [] };
  }
  let index = 0;
  for (const want of actions) {
    const skipped = skipChance(nodes, index);
    index = skipped.index;
    const node = skipped.node;
    if (!node) {
      return { ok: false, reason: "missing node", nodeIndex: index, legal: [] };
    }
    if (node.terminal) {
      return {
        ok: false,
        reason: `terminal before ${want}`,
        nodeIndex: index,
        legal: [],
        missing: want,
      };
    }
    const legal = node.actions.map((a) => a.label);
    const hit = node.actions.find((a) => labelsMatch(want, a.label));
    if (!hit) {
      return {
        ok: false,
        reason: `no child matching ${want}`,
        nodeIndex: index,
        legal,
        missing: want,
      };
    }
    index = hit.child_index;
  }
  const skipped = skipChance(nodes, index);
  index = skipped.index;
  const node = skipped.node;
  const legal = node && !node.terminal && !node.chance ? node.actions.map((a) => a.label) : [];
  return { ok: true, nodeIndex: index, legal };
}

/**
 * Path Study should open: follow the played line, but stop on the last
 * decision node (do not land on a terminal after Call/Fold/check-down).
 */
export function decisionActionsForStudy(
  nodes: TreePreviewNode[],
  actionLine: string[],
): {
  actions: string[];
  path: string;
  missing_sizes: string[];
  legal: string[];
  ok: boolean;
} {
  const missing_sizes: string[] = [];
  const taken: string[] = [];
  let index = 0;

  for (const want of actionLine) {
    const skipped = skipChance(nodes, index);
    index = skipped.index;
    const node = skipped.node;
    if (!node || node.terminal) {
      missing_sizes.push(want);
      break;
    }
    const hit = node.actions.find((a) => labelsMatch(want, a.label));
    if (!hit) {
      missing_sizes.push(want);
      break;
    }
    const childIndex = hit.child_index;
    const child = skipChance(nodes, childIndex).node;
    // Taking this action reaches a terminal → Study stays on the current decision.
    if (child?.terminal) {
      break;
    }
    taken.push(want);
    index = childIndex;
  }

  const end = walkPreviewActions(nodes, taken);
  const legal = end.ok ? end.legal : [];
  return {
    actions: taken,
    path: taken.join("/"),
    missing_sizes,
    legal,
    ok: missing_sizes.length === 0,
  };
}

/**
 * When no compiled preview is available yet, drop trailing Call/Fold (and
 * check-down Check) so the path targets a decision rather than a terminal.
 */
export function heuristicDecisionActions(actionLine: string[]): string[] {
  const line = [...actionLine];
  while (line.length > 0) {
    const last = line[line.length - 1];
    if (last === "Fold" || last === "Call") {
      line.pop();
      continue;
    }
    if (
      last === "Check" &&
      line.length >= 2 &&
      line[line.length - 2] === "Check"
    ) {
      line.pop();
      continue;
    }
    break;
  }
  return line;
}

/** Validate a stored decision path must land on a decision with legal actions. */
export function assertDecisionIsStudyNode(
  nodes: TreePreviewNode[],
  actions: string[],
): { ok: true; legal: string[] } | { ok: false; reason: string; missing?: string } {
  const walk = walkPreviewActions(nodes, actions);
  if (!walk.ok) {
    return { ok: false, reason: walk.reason, missing: walk.missing };
  }
  const node = nodes[walk.nodeIndex];
  if (!node || node.terminal || node.chance) {
    return {
      ok: false,
      reason: "decision path landed on a non-decision node (often after Call/Fold)",
    };
  }
  if (walk.legal.length === 0) {
    return { ok: false, reason: "decision node has no legal actions" };
  }
  return { ok: true, legal: walk.legal };
}
