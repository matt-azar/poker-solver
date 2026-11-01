import { useMemo } from "react";
import { mapActionColors } from "../../domain/actionColors";
import { groupEv, groupHands } from "../../domain/browse";
import { handIndexForCombo, isHandLocked, lockForNode } from "../../domain/locks";
import { useStudyStore } from "../../state/studyStore";

export function ComboInspector() {
  const currentNode = useStudyStore((s) => s.currentNode);
  const nodeValues = useStudyStore((s) => s.nodeValues);
  const selectedCell = useStudyStore((s) => s.selectedCell);
  const hoverCell = useStudyStore((s) => s.hoverCell);
  const calculateEv = useStudyStore((s) => s.calculateEv);
  const setSelectedCell = useStudyStore((s) => s.setSelectedCell);
  const selectCombosForLock = useStudyStore((s) => s.selectCombosForLock);
  const setLockDrawerOpen = useStudyStore((s) => s.setLockDrawerOpen);
  const toggleLockHand = useStudyStore((s) => s.toggleLockHand);
  const unlockHands = useStudyStore((s) => s.unlockHands);
  const lockDraft = useStudyStore((s) => s.lockDraft);
  const locks = useStudyStore((s) => s.locks);

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

  const nodeLock = useMemo(
    () => (currentNode ? lockForNode(locks, currentNode.node_id) : null),
    [locks, currentNode],
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
          ) : null}
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
            {cell.hands.map((hand) => {
              const handIndex = handIndexForCombo(currentNode.combos, hand.combo);
              const locked = handIndex >= 0 ? isHandLocked(nodeLock, handIndex) : false;
              const inDraft =
                handIndex >= 0 && lockDraft.handIndices.includes(handIndex);
              return (
                <div
                  key={hand.combo}
                  className="inspector-combo"
                  data-locked={locked ? "true" : "false"}
                  data-lock-draft={inDraft ? "true" : "false"}
                >
                  <input
                    type="checkbox"
                    checked={inDraft}
                    disabled={handIndex < 0}
                    onChange={() => {
                      if (handIndex >= 0) {
                        toggleLockHand(handIndex);
                      }
                    }}
                    aria-label={`Select ${hand.combo} for lock`}
                    title="Include in lock draft"
                  />
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
                    {locked ? "L · " : ""}
                    {hand.actions
                      .map((action) => `${(action.probability * 100).toFixed(0)}`)
                      .join("/")}
                  </span>
                  {handIndex >= 0 ? (
                    locked ? (
                      <button
                        type="button"
                        className="toolbar-btn inspector-lock-btn"
                        onClick={() => void unlockHands([handIndex])}
                      >
                        Unlock
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="toolbar-btn inspector-lock-btn"
                        onClick={() => selectCombosForLock([hand.combo])}
                      >
                        Lock
                      </button>
                    )
                  ) : null}
                </div>
              );
            })}
          </div>
          <div className="inspector-lock-actions">
            <button
              type="button"
              className="toolbar-btn primary"
              onClick={() =>
                selectCombosForLock(cell.hands.map((hand) => hand.combo))
              }
            >
              Lock selection
            </button>
            <button
              type="button"
              className="toolbar-btn"
              onClick={() => setLockDrawerOpen(true)}
            >
              Lock editor
            </button>
            {pinned ? (
              <button
                type="button"
                className="toolbar-btn"
                onClick={() => setSelectedCell(null)}
              >
                Clear selection
              </button>
            ) : null}
          </div>
        </>
      )}
    </aside>
  );
}
