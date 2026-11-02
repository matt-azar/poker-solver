import { useMemo } from "react";
import { actionSizePotBasis } from "../../domain/actionHistory";
import { mapActionColors } from "../../domain/actionColors";
import {
  formatActionDisplay,
  formatActionTooltip,
  formatFrequencyPct,
} from "../../domain/betSizes";
import { groupHands } from "../../domain/browse";
import type { MatrixMode } from "../../domain/types";
import { useSettingsStore } from "../../state/settingsStore";
import { useStudyStore } from "../../state/studyStore";
import { ActionBlock } from "./ActionBlock";
import "../../styles/actions.css";

const MODES: Array<{ id: MatrixMode; label: string }> = [
  { id: "strategy", label: "Strategy" },
  { id: "range", label: "Range" },
  { id: "ev", label: "EV" },
];

function childIdAt(
  children: unknown[] | undefined,
  index: number,
): string | null {
  if (!children) {
    return null;
  }
  const child = children[index];
  if (!child) {
    return null;
  }
  if (typeof child === "string") {
    return child;
  }
  if (
    typeof child === "object" &&
    child !== null &&
    "node_id" in child &&
    typeof (child as { node_id?: unknown }).node_id === "string" &&
    (child as { node_id: string }).node_id
  ) {
    return (child as { node_id: string }).node_id;
  }
  return null;
}

export function ActionSummary() {
  const currentNode = useStudyStore((s) => s.currentNode);
  const status = useStudyStore((s) => s.status);
  const draft = useStudyStore((s) => s.draft);
  const matrixMode = useStudyStore((s) => s.matrixMode);
  const setMatrixMode = useStudyStore((s) => s.setMatrixMode);
  const actionFilter = useStudyStore((s) => s.actionFilter);
  const setActionFilter = useStudyStore((s) => s.setActionFilter);
  const followAction = useStudyStore((s) => s.followAction);
  const nodeValues = useStudyStore((s) => s.nodeValues);
  const betSizeDisplay = useSettingsStore((s) => s.settings.betSizeDisplay);

  const actions = currentNode?.actions;
  const pot = actionSizePotBasis(
    currentNode,
    Number(status?.pot ?? draft.pot ?? 0),
  );

  const colors = useMemo(
    () => mapActionColors(actions ?? []),
    [actions],
  );

  const freqs = useMemo(() => {
    const labels = actions ?? [];
    if (!currentNode) {
      return labels.map(() => 0);
    }
    const cells = groupHands(currentNode);
    const totals = labels.map(() => 0);
    let mass = 0;
    for (const cell of cells) {
      if (!cell.defined || cell.marginalSum <= 0) {
        continue;
      }
      mass += cell.marginalSum;
      cell.actionMass.forEach((m, i) => {
        totals[i] += m;
      });
    }
    if (!(mass > 0)) {
      return labels.map(() => 0);
    }
    return totals.map((t) => t / mass);
  }, [currentNode, actions]);

  const evReady = Boolean(nodeValues && !nodeValues.pending);
  const strategyActive =
    matrixMode === "strategy" || matrixMode === "strategy-ev";

  const legend = useMemo(
    () =>
      colors.legend.map((entry) => {
        const display = formatActionDisplay(entry.label, pot, "pot");
        return {
          key: entry.label,
          label: display.primary,
          color: entry.color,
        };
      }),
    [colors.legend, pot],
  );

  return (
    <div className="action-summary">
      <div className="action-summary__modes" role="group" aria-label="Matrix mode">
        {MODES.map((mode) => {
          const pressed =
            mode.id === "strategy"
              ? strategyActive
              : matrixMode === mode.id;
          return (
            <button
              key={mode.id}
              type="button"
              className="mode-btn"
              aria-pressed={pressed}
              disabled={mode.id === "ev" && !evReady}
              onClick={() => setMatrixMode(mode.id)}
            >
              {mode.label}
            </button>
          );
        })}
      </div>
      {(actions ?? []).map((label, index) => {
        const display = formatActionDisplay(label, pot, betSizeDisplay);
        const freqText = formatFrequencyPct(freqs[index]);
        const childId = childIdAt(currentNode?.children, index);
        const filtered = actionFilter === index;
        return (
          <ActionBlock
            key={`${label}-${index}`}
            variant="filter"
            primary={display.primary}
            secondary={display.secondary}
            frequency={freqs[index] ?? 0}
            frequencyText={freqText}
            color={colors.byIndex[index]}
            active={filtered}
            title={`${formatActionTooltip(label, pot, betSizeDisplay)} · click to filter`}
            aria-label={`Filter ${display.primary}${freqText ? `, ${freqText}` : ""}`}
            onClick={() => setActionFilter(filtered ? null : index)}
            onFollow={() => {
              if (childId) {
                void followAction(childId);
              }
            }}
            followDisabled={!childId}
            followLabel="Open"
          />
        );
      })}
      {!actions?.length ? <span className="muted">No actions at this node</span> : null}
      {legend.length > 0 ? (
        <div className="action-summary__legend" aria-label="Action color legend">
          {legend.map((entry) => (
            <span key={entry.key} className="action-summary__legend-item">
              <span
                className="action-summary__legend-swatch"
                style={{ background: entry.color }}
                aria-hidden
              />
              {entry.label}
            </span>
          ))}
        </div>
      ) : null}
      {(actions?.length ?? 0) > 0 ? (
        <p className="action-summary__hint">
          Block filters the matrix · Open follows that action
        </p>
      ) : null}
    </div>
  );
}
