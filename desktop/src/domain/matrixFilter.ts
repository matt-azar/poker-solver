/**
 * Study matrix action-filter thresholds and helpers.
 * Dim cutoff is visible beside the active filter chip so players can trust 1% rows.
 */

/** Minimum action share of a 169-cell before the filter dims it (2%). */
export const ACTION_FILTER_DIM_THRESHOLD = 0.02;

/** Percent label for the dim cutoff (`2%`). */
export function actionFilterDimThresholdPct(
  threshold: number = ACTION_FILTER_DIM_THRESHOLD,
): string {
  return `${Math.round(threshold * 100)}%`;
}

export function actionShareMeetsFilter(
  share: number,
  threshold: number = ACTION_FILTER_DIM_THRESHOLD,
): boolean {
  return share >= threshold;
}
