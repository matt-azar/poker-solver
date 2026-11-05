import { useMemo } from "react";
import { mapActionColors } from "../../domain/actionColors";
import { groupEv, groupHands, withEvBasis } from "../../domain/browse";
import { handIndexForCombo, isHandLocked, lockForNode } from "../../domain/locks";
import type {
  ActionValuesPayload,
  EvDisplayBasis,
  NodePayload,
} from "../../domain/types";
import { useStudyStore } from "../../state/studyStore";

function comboActionEvs(
  node: NodePayload,
  values: ActionValuesPayload | null,
  combo: string,
  basis: EvDisplayBasis,
): Array<number | null> | null {
  const displayed = withEvBasis(values, basis, node.actions);
  if (!displayed || displayed.pending) {
    return null;
  }
  if (displayed.node_id && node.node_id && displayed.node_id !== node.node_id) {
    return null;
  }
  const combos = displayed.combos || node.combos || [];
  const valueIndex = combos.indexOf(combo);
  const nodeIndex = (node.combos || []).indexOf(combo);
  if (valueIndex < 0 || nodeIndex < 0) {
    return null;
  }
  if (!displayed.ev_defined?.[valueIndex]) {
    return null;
  }
  const marginal = Number(node.marginal?.[nodeIndex] ?? 0);
  if (!(marginal > 0)) {
    return null;
  }
  const row = displayed.action_ev?.[valueIndex];
  if (!row) {
    return null;
  }
  return row.map((entry) =>
    entry == null || Number.isNaN(Number(entry)) ? null : Number(entry),
  );
}

/** Hands list for the hovered/selected 169-cell in the Study detail panel. */
export function ComboInspector() {
  const currentNode = useStudyStore((s) => s.currentNode);
  const nodeValues = useStudyStore((s) => s.nodeValues);
  const evDisplayBasis = useStudyStore((s) => s.evDisplayBasis);
  const selectedCell = useStudyStore((s) => s.selectedCell);
  const hoverCell = useStudyStore((s) => s.hoverCell);
  const calculateEv = useStudyStore((s) => s.calculateEv);
  const setSelectedCell = useStudyStore((s) => s.setSelectedCell);
  const selectCombosForLock = useStudyStore((s) => s.selectCombosForLock);
  const selectCombosForStrategyEdit = useStudyStore((s) => s.selectCombosForStrategyEdit);
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

  const ev =
    cell && currentNode
      ? groupEv(currentNode, nodeValues, cell, evDisplayBasis)
      : null;
  const pinned = Boolean(selectedCell);
  const actions = currentNode?.actions ?? [];
  const evReady = Boolean(nodeValues && !nodeValues.pending);

  return (
    <section className="combo-inspector" aria-label="Hands">
      <div className="combo-inspector__head panel-title-row">
        <h2 className="panel-title">Hands</h2>
        <span className="combo-inspector__focus tabular">
          {focus?.text ?? ""}
        </span>
        <span className="muted">
          {pinned ? "Pinned" : focus ? "Hover" : ""}
        </span>
      </div>
      {!currentNode ? (
        <p className="empty-hint">Solve a spot, then hover a hand in the grid.</p>
      ) : !cell ? (
        <p className="empty-hint">Hover a hand in the grid.</p>
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
              <span className="muted">
                {evDisplayBasis === "local" ? "Mixed EV" : "Mixed EV (global)"}
              </span>
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
          {actions.length > 0 ? (
            <div className="hands-ev-legend" aria-hidden={!evReady}>
              <span className="hands-ev-legend__spacer" />
              {actions.map((label, index) => (
                <span
                  key={`ev-h-${label}-${index}`}
                  className="hands-ev-legend__action tabular"
                  style={{ color: colors.byIndex[index] }}
                >
                  {label}
                </span>
              ))}
            </div>
          ) : null}
          <div className="inspector-combos">
            {cell.hands.map((hand) => {
              const handIndex = handIndexForCombo(currentNode.combos, hand.combo);
              const locked = handIndex >= 0 ? isHandLocked(nodeLock, handIndex) : false;
              const inDraft =
                handIndex >= 0 && lockDraft.handIndices.includes(handIndex);
              const actionEvs = comboActionEvs(
                currentNode,
                nodeValues,
                hand.combo,
                evDisplayBasis,
              );
              return (
                <div
                  key={hand.combo}
                  className="inspector-combo hands-combo"
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
                  <code className="hands-combo__code">{hand.combo}</code>
                  <div className="inspector-combo__mix hands-combo__mix">
                    {hand.actions.map((action) => (
                      <i
                        key={action.action}
                        title={`${action.action} ${(action.probability * 100).toFixed(0)}%`}
                        style={{
                          background: colors.byLabel[action.action] || "#666",
                          width: `${Math.max(0, action.probability * 100)}%`,
                        }}
                      />
                    ))}
                  </div>
                  <div className="hands-combo__evs">
                    {actions.map((label, index) => {
                      const value = actionEvs?.[index];
                      return (
                        <span
                          key={`${hand.combo}-ev-${index}`}
                          className="hands-combo__ev tabular"
                          title={label}
                        >
                          {value == null ? "—" : value.toFixed(2)}
                        </span>
                      );
                    })}
                  </div>
                  <span className="tabular muted hands-combo__freq">
                    {locked ? "L · " : ""}
                    {hand.actions
                      .map((action) => `${(action.probability * 100).toFixed(0)}`)
                      .join("/")}
                  </span>
                  {handIndex >= 0 && locked ? (
                    <button
                      type="button"
                      className="toolbar-btn inspector-lock-btn"
                      onClick={() => void unlockHands([handIndex])}
                    >
                      Unlock
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
          <div className="inspector-lock-actions">
            <button
              type="button"
              className="toolbar-btn primary"
              disabled={lockDraft.handIndices.length === 0}
              onClick={() => {
                const combos = lockDraft.handIndices
                  .map((index) => currentNode.combos?.[index])
                  .filter((combo): combo is string => typeof combo === "string");
                selectCombosForLock(combos);
              }}
            >
              Lock selection
            </button>
            <button
              type="button"
              className="toolbar-btn"
              onClick={() =>
                selectCombosForLock(cell.hands.map((hand) => hand.combo))
              }
            >
              Lock entire hand class
            </button>
            <button
              type="button"
              className="toolbar-btn"
              onClick={() =>
                selectCombosForStrategyEdit(cell.hands.map((hand) => hand.combo))
              }
            >
              Edit strategy
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
    </section>
  );
}
