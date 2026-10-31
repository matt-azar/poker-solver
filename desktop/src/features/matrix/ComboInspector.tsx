import { useMemo } from "react";
import { mapActionColors } from "../../domain/actionColors";
import { groupEv, groupHands } from "../../domain/browse";
import { useStudyStore } from "../../state/studyStore";

export function ComboInspector() {
  const currentNode = useStudyStore((s) => s.currentNode);
  const nodeValues = useStudyStore((s) => s.nodeValues);
  const selectedCell = useStudyStore((s) => s.selectedCell);
  const hoverCell = useStudyStore((s) => s.hoverCell);
  const calculateEv = useStudyStore((s) => s.calculateEv);
  const setSelectedCell = useStudyStore((s) => s.setSelectedCell);

  const focus = selectedCell ?? hoverCell;
  const cell = useMemo(() => {
    if (!currentNode || !focus) {
      return null;
    }
    return groupHands(currentNode).find((entry) => entry.text === focus.text) ?? null;
  }, [currentNode, focus]);

  const colors = useMemo(
    () => mapActionColors(currentNode?.actions ?? []),
    [currentNode?.actions],
  );

  const ev = cell && currentNode ? groupEv(currentNode, nodeValues, cell) : null;
  const pinned = Boolean(selectedCell);

  return (
    <aside className="combo-inspector" aria-label="Combo inspector">
      <div className="panel-title-row">
        <h2 className="panel-title">{focus?.text ?? "No selection"}</h2>
        <span className="muted">{pinned ? "Pinned" : focus ? "Hover" : ""}</span>
      </div>
      {!currentNode ? (
        <p className="empty-hint">Load a solved node to inspect combos.</p>
      ) : !cell ? (
        <p className="empty-hint">Select a hand class in the matrix.</p>
      ) : (
        <>
          <div className="inspector-meta">
            <div>
              <span className="muted">Combos</span>
              <strong>{cell.range_combos}</strong>
            </div>
            <div>
              <span className="muted">Reach mass</span>
              <strong className="tabular">
                {cell.defined ? cell.marginalSum.toFixed(4) : "—"}
              </strong>
            </div>
            <div>
              <span className="muted">Mixed EV</span>
              <strong className="tabular">
                {ev ? ev.mixed.toFixed(3) : nodeValues?.pending ? "…" : "—"}
              </strong>
            </div>
          </div>
          {!nodeValues || nodeValues.pending ? (
            <button type="button" className="toolbar-btn" onClick={() => void calculateEv()}>
              Calculate action EVs
            </button>
          ) : (
            <p className="hint">
              Units: {nodeValues.units || "chips"}, basis:{" "}
              {nodeValues.utility_basis || "root_centered"}
            </p>
          )}
          <div className="inspector-actions">
            {(currentNode.actions || []).map((label, index) => {
              const share =
                cell.defined && cell.marginalSum > 0
                  ? cell.actionMass[index] / cell.marginalSum
                  : null;
              return (
                <div key={`${label}-${index}`} className="inspector-action-row">
                  <span
                    className="action-swatch"
                    style={{ background: colors.byIndex[index] }}
                  />
                  <span>{label}</span>
                  <span className="tabular">
                    {share == null ? "—" : `${(share * 100).toFixed(1)}%`}
                  </span>
                  <span className="tabular muted">
                    {ev ? ev.action[index].toFixed(2) : "—"}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="inspector-combos">
            {cell.hands.map((hand) => (
              <div key={hand.combo} className="inspector-combo">
                <code>{hand.combo}</code>
                <div className="inspector-combo__mix">
                  {hand.actions.map((action) => (
                    <span key={action.action} title={action.action}>
                      <i
                        style={{
                          background: colors.byLabel[action.action] || "#666",
                          width: `${Math.max(2, action.probability * 100)}%`,
                        }}
                      />
                    </span>
                  ))}
                </div>
                <span className="tabular muted">
                  {hand.actions
                    .map((action) => `${(action.probability * 100).toFixed(0)}`)
                    .join("/")}
                </span>
              </div>
            ))}
          </div>
          {pinned ? (
            <button
              type="button"
              className="toolbar-btn"
              onClick={() => setSelectedCell(null)}
            >
              Clear selection
            </button>
          ) : null}
        </>
      )}
    </aside>
  );
}
