import { useMemo } from "react";
import { actionSizePotBasis } from "../../domain/actionHistory";
import { mapActionColors } from "../../domain/actionColors";
import {
  formatActionDisplay,
  formatActionNavLabel,
} from "../../domain/betSizes";
import {
  ACTION_FILTER_DIM_THRESHOLD,
  actionFilterDimThresholdPct,
} from "../../domain/matrixFilter";
import { useSettingsStore } from "../../state/settingsStore";
import { useStudyStore } from "../../state/studyStore";
import "../../styles/actions.css";

/** Active matrix action-filter chip with one-click clear (beside the grid toolbar). */
export function MatrixFilterChip() {
  const currentNode = useStudyStore((s) => s.currentNode);
  const status = useStudyStore((s) => s.status);
  const draft = useStudyStore((s) => s.draft);
  const actionFilter = useStudyStore((s) => s.actionFilter);
  const setActionFilter = useStudyStore((s) => s.setActionFilter);
  const betSizeDisplay = useSettingsStore((s) => s.settings.betSizeDisplay);

  const actions = currentNode?.actions ?? [];
  const pot = actionSizePotBasis(
    currentNode,
    Number(status?.pot ?? draft.pot ?? 0),
  );
  const toCall = Number(currentNode?.to_call ?? 0);
  const colors = useMemo(
    () => mapActionColors(actions, { pot, toCall }),
    [actions, pot, toCall],
  );

  if (actionFilter == null || actionFilter < 0 || actionFilter >= actions.length) {
    return null;
  }

  const label = actions[actionFilter]!;
  const navLabel = formatActionNavLabel(label, pot, { toCall });
  const compact = formatActionDisplay(label, pot, betSizeDisplay === "chips" ? "chips" : "pot", {
    toCall,
  }).primary;
  const thresholdPct = actionFilterDimThresholdPct(ACTION_FILTER_DIM_THRESHOLD);

  return (
    <div
      className="matrix-filter-chip"
      role="status"
      aria-label={`Matrix filter ${navLabel}, dim below ${thresholdPct}`}
      style={{ ["--action-color" as string]: colors.byIndex[actionFilter] }}
    >
      <span className="matrix-filter-chip__swatch" aria-hidden />
      <span className="matrix-filter-chip__label">
        Filter {compact}
        <span className="matrix-filter-chip__unit muted"> · freq ≥ {thresholdPct}</span>
      </span>
      <button
        type="button"
        className="matrix-filter-chip__clear"
        aria-label="Clear action filter"
        title="Clear filter"
        onClick={() => setActionFilter(null)}
      >
        Clear
      </button>
    </div>
  );
}
