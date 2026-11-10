/**
 * Shared strategy-bar paint model for Study.
 *
 * Matrix cells, Hands combo tiles, Node Locking paint cells, and the Actions
 * frequency mix bar all build segments through this helper so order (passive →
 * aggressive left→right), colors, and the min-weight cutoff stay on one path.
 */
import { orderActionIndicesByAggression } from "./actionOrder";

/** Drop segments thinner than this (same threshold historically used in-matrix). */
export const STRATEGY_PAINT_MIN_WEIGHT = 0.001;

export type StrategyPaintSegment = {
  /** Index into the node's `actions` / mix arrays. */
  index: number;
  /** Mix weight in [0, 1]; drives flex-grow width. */
  weight: number;
  /** Palette color from `mapActionColors`. */
  color: string;
  /** Original action label when available. */
  label: string;
};

export type BuildStrategyPaintSegmentsOptions = {
  /** Override the shared min-weight filter (default STRATEGY_PAINT_MIN_WEIGHT). */
  minWeight?: number;
  /**
   * When true, keep zero-weight slots in paint order (useful for debugging).
   * Default false — matches matrix / Hands / lock / Actions mix chrome.
   */
  includeZero?: boolean;
};

/**
 * Build passive→aggressive paint segments from an action mix and color table.
 *
 * `mix[i]` is the frequency (or mass share) for `actions[i]`. Missing/NaN
 * weights are treated as 0. Returns [] when there is nothing to paint.
 */
export function buildStrategyPaintSegments(
  actions: readonly string[],
  mix: ReadonlyArray<number | null | undefined> | null | undefined,
  colorsByIndex: readonly string[],
  options: BuildStrategyPaintSegmentsOptions = {},
): StrategyPaintSegment[] {
  if (!actions.length || !mix || mix.length === 0) {
    return [];
  }
  const minWeight = options.minWeight ?? STRATEGY_PAINT_MIN_WEIGHT;
  const includeZero = options.includeZero === true;
  const order = orderActionIndicesByAggression([...actions]);
  const segments: StrategyPaintSegment[] = [];
  for (const index of order) {
    const raw = mix[index];
    const weight =
      raw == null || Number.isNaN(Number(raw)) ? 0 : Math.max(0, Number(raw));
    if (!includeZero && !(weight > minWeight)) {
      continue;
    }
    segments.push({
      index,
      weight,
      color: colorsByIndex[index] || "#666",
      label: actions[index] ?? "",
    });
  }
  return segments;
}
