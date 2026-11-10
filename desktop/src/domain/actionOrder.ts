/**
 * Order Study action segments most-aggressive → least-aggressive (left → right).
 * Shared by the main matrix, Hands combo breakdowns, Node Locking bars/cells,
 * and the Actions panel frequency mix bar.
 */
import { actionIdentity } from "./actionColors";

function normalizeLabel(label: string): string {
  return label.trim();
}

function isAllIn(label: string): boolean {
  const lower = label.toLowerCase();
  return (
    lower.includes("all-in") ||
    lower.includes("allin") ||
    /\ball\s*in\b/.test(lower)
  );
}

/** Numeric aggression score — higher paints further left. */
export function actionAggressionScore(label: string): number {
  const normalized = normalizeLabel(label);
  if (!normalized) {
    return Number.NEGATIVE_INFINITY;
  }
  const id = actionIdentity(normalized);
  if (id === "fold") {
    return -200;
  }
  if (id === "check") {
    return -100;
  }
  // Calling an all-in ranks with Call, not with aggressive All-in.
  if (id === "call") {
    return -50;
  }
  if (id === "all-in" || isAllIn(normalized)) {
    return 1_000_000;
  }
  const sized = id.match(/^(?:bet|raise):([\d.]+)/i);
  if (sized) {
    const size = Number(sized[1]);
    // Raises slightly outrank equal-size bets.
    return size + (id.startsWith("raise") ? 0.001 : 0);
  }
  const compact = normalized.match(/^([br])(\d+(?:\.\d+)?)/i);
  if (compact) {
    const size = Number(compact[2]);
    return size + (compact[1].toLowerCase() === "r" ? 0.001 : 0);
  }
  // Unknown non-passive labels — treat as mid aggression.
  return 0;
}

/** Sort comparator: aggressive first (descending score). */
export function compareActionsAggressiveFirst(left: string, right: string): number {
  const delta = actionAggressionScore(right) - actionAggressionScore(left);
  if (delta !== 0) {
    return delta;
  }
  return normalizeLabel(left).localeCompare(normalizeLabel(right));
}

/** Indices into `actions` ordered most-aggressive → least-aggressive. */
export function orderActionIndicesByAggression(actions: string[]): number[] {
  return actions
    .map((_, index) => index)
    .sort((left, right) =>
      compareActionsAggressiveFirst(actions[left] ?? "", actions[right] ?? ""),
    );
}
