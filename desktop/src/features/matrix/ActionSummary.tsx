import { useMemo } from "react";
import { mapActionColors } from "../../domain/actionColors";
import { groupHands } from "../../domain/browse";
import type { MatrixMode } from "../../domain/types";
import { useStudyStore } from "../../state/studyStore";

const MODES: Array<{ id: MatrixMode; label: string }> = [
  { id: "strategy", label: "Strategy" },
  { id: "range", label: "Range" },
  { id: "ev", label: "EV" },
];

export function ActionSummary() {
  const currentNode = useStudyStore((s) => s.currentNode);
  const matrixMode = useStudyStore((s) => s.matrixMode);
  const setMatrixMode = useStudyStore((s) => s.setMatrixMode);
  const actionFilter = useStudyStore((s) => s.actionFilter);
  const setActionFilter = useStudyStore((s) => s.setActionFilter);
  const followAction = useStudyStore((s) => s.followAction);
  const nodeValues = useStudyStore((s) => s.nodeValues);

  const actions = currentNode?.actions;

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

  const followTarget = useMemo(() => {
    if (actionFilter == null || !currentNode?.children) {
      return null;
    }
    const children = currentNode.children;
    const child = children[actionFilter];
    if (!child) {
      return null;
    }
    if (typeof child === "string") {
      return child;
    }
    if ("node_id" in child && child.node_id) {
      return child.node_id;
    }
    return null;
  }, [actionFilter, currentNode]);

  const evReady = Boolean(nodeValues && !nodeValues.pending);
  const strategyActive =
    matrixMode === "strategy" || matrixMode === "strategy-ev";

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
      {(actions ?? []).map((label, index) => (
        <button
          key={`${label}-${index}`}
          type="button"
          className="action-chip"
          data-active={actionFilter === index}
          title="Filter highlight"
          onClick={() => setActionFilter(actionFilter === index ? null : index)}
        >
          <span className="action-swatch" style={{ background: colors.byIndex[index] }} />
          <span>{label}</span>
          <span className="action-chip__freq">{(freqs[index] * 100).toFixed(1)}%</span>
        </button>
      ))}
      {!actions?.length ? <span className="muted">No actions at this node</span> : null}
      <button
        type="button"
        className="toolbar-btn follow-btn"
        disabled={!followTarget}
        onClick={() => {
          if (followTarget) {
            void followAction(followTarget);
          }
        }}
      >
        Follow action
      </button>
    </div>
  );
}
