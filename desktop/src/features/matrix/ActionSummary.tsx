import { useMemo } from "react";
import { actionSizePotBasis } from "../../domain/actionHistory";
import { mapActionColors } from "../../domain/actionColors";
import {
  formatActionDisplay,
  formatActionTooltip,
  formatFrequencyPct,
} from "../../domain/betSizes";
import { groupHands } from "../../domain/browse";
import { useSettingsStore } from "../../state/settingsStore";
import { useStudyStore } from "../../state/studyStore";
import { ActionBlock } from "./ActionBlock";
import "../../styles/actions.css";

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

/** Node-level Actions stack for the Study detail panel. */
export function ActionSummary() {
  const currentNode = useStudyStore((s) => s.currentNode);
  const status = useStudyStore((s) => s.status);
  const draft = useStudyStore((s) => s.draft);
  const actionFilter = useStudyStore((s) => s.actionFilter);
  const setActionFilter = useStudyStore((s) => s.setActionFilter);
  const followAction = useStudyStore((s) => s.followAction);
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

  return (
    <section className="action-summary action-summary--panel" aria-label="Actions">
      <div className="action-summary__head">
        <h2 className="action-summary__title">Actions</h2>
        {(actions?.length ?? 0) > 0 ? (
          <span className="muted action-summary__hint-inline">
            Filter · Open
          </span>
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
          const childId = childIdAt(currentNode?.children, index);
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
              title={`${formatActionTooltip(label, pot, betSizeDisplay, displayOpts)} · click to filter`}
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
        {!actions?.length ? (
          <span className="muted">No actions at this node</span>
        ) : null}
      </div>
      {(actions?.length ?? 0) > 0 ? (
        <div
          className="action-summary__mix"
          aria-label="Action frequency mix"
          role="img"
        >
          {freqs.map((freq, index) =>
            freq > 0.001 ? (
              <span
                key={`mix-${index}`}
                className="action-summary__mix-seg"
                style={{
                  flexGrow: freq,
                  flexBasis: 0,
                  background: colors.byIndex[index],
                }}
                title={`${actions?.[index] ?? ""} · ${formatFrequencyPct(freq)}`}
              />
            ) : null,
          )}
        </div>
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
