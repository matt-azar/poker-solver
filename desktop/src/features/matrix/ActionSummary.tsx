import { useMemo } from "react";
import { actionSizePotBasis } from "../../domain/actionHistory";
import { mapActionColors } from "../../domain/actionColors";
import {
  formatActionDisplay,
  formatActionTooltip,
  formatFrequencyPct,
} from "../../domain/betSizes";
import { groupHands } from "../../domain/browse";
import { buildStrategyPaintSegments } from "../../domain/strategyPaint";
import { useSettingsStore } from "../../state/settingsStore";
import { useStudyStore } from "../../state/studyStore";
import { ActionBlock } from "./ActionBlock";
import { StrategyPaintBars } from "./StrategyPaintBars";
import "../../styles/actions.css";

/** Node-level Actions stack for the Study detail panel. */
export function ActionSummary() {
  const currentNode = useStudyStore((s) => s.currentNode);
  const status = useStudyStore((s) => s.status);
  const draft = useStudyStore((s) => s.draft);
  const actionFilter = useStudyStore((s) => s.actionFilter);
  const setActionFilter = useStudyStore((s) => s.setActionFilter);
  const betSizeDisplay = useSettingsStore((s) => s.settings.betSizeDisplay);

  const actions = currentNode?.actions;
  const pot = actionSizePotBasis(
    currentNode,
    Number(status?.pot ?? draft.pot ?? 0),
  );
  const toCall = Number(currentNode?.to_call ?? 0);
  const displayOpts = useMemo(() => ({ toCall }), [toCall]);

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

  const legend = useMemo(
    () =>
      colors.legend.map((entry) => {
        const display = formatActionDisplay(
          entry.label,
          pot,
          betSizeDisplay === "chips" ? "chips" : "pot",
          displayOpts,
        );
        return {
          key: entry.label,
          label: display.primary,
          color: entry.color,
        };
      }),
    [colors.legend, pot, betSizeDisplay, displayOpts],
  );

  const mixSegments = useMemo(
    () =>
      buildStrategyPaintSegments(actions ?? [], freqs, colors.byIndex),
    [actions, freqs, colors.byIndex],
  );

  return (
    <section className="action-summary action-summary--panel" aria-label="Actions">
      <div className="action-summary__head">
        <h2 className="action-summary__title">Actions</h2>
        {(actions?.length ?? 0) > 0 ? (
          <span className="muted action-summary__hint-inline">Filter</span>
        ) : null}
      </div>
      <div className="action-summary__blocks">
        {(actions ?? []).map((label, index) => {
          const display = formatActionDisplay(
            label,
            pot,
            betSizeDisplay,
            displayOpts,
          );
          const freqText = formatFrequencyPct(freqs[index]);
          const filtered = actionFilter === index;
          return (
            <ActionBlock
              key={`${label}-${index}`}
              primary={display.primary}
              secondary={display.secondary}
              frequency={freqs[index] ?? 0}
              frequencyText={freqText}
              color={colors.byIndex[index]}
              active={filtered}
              title={`${formatActionTooltip(label, pot, betSizeDisplay, displayOpts)} · click to filter`}
              aria-label={`Filter ${display.primary}${freqText ? `, ${freqText}` : ""}`}
              onClick={() => setActionFilter(filtered ? null : index)}
            />
          );
        })}
        {!actions?.length ? (
          <span className="muted">No actions at this node</span>
        ) : null}
      </div>
      {(actions?.length ?? 0) > 0 ? (
        <StrategyPaintBars
          segments={mixSegments}
          className="action-summary__mix"
          segClassName="action-summary__mix-seg"
          role="img"
          aria-label="Action frequency mix"
        />
      ) : null}
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
    </section>
  );
}
