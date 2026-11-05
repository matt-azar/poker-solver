import { useMemo } from "react";
import { mapActionColors } from "../../domain/actionColors";
import { groupEv, groupHands, withEvBasis } from "../../domain/browse";
import { handIndexForCombo, isHandLocked, lockForNode } from "../../domain/locks";
import {
  cellShape,
  comboBreakdown,
  comboKey,
  type ComboBreakdownSquare,
} from "../../domain/matrixDisplay";
import type {
  ActionValuesPayload,
  EvDisplayBasis,
  NodePayload,
} from "../../domain/types";
import { RANKS } from "../../domain/types";
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
  const key = comboKey(combo);
  const valueIndex = combos.findIndex((entry) => comboKey(entry) === key);
  const nodeIndex = (node.combos || []).findIndex((entry) => comboKey(entry) === key);
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

function shapeColumns(shape: ReturnType<typeof cellShape>): number {
  if (shape === "suited") {
    return 2;
  }
  if (shape === "pair") {
    return 3;
  }
  return 4;
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

  const squares = useMemo(() => {
    if (!cell || !currentNode) {
      return [] as ComboBreakdownSquare[];
    }
    return comboBreakdown(
      cell,
      currentNode,
      nodeValues,
      new Map(),
      evDisplayBasis,
      RANKS,
    );
  }, [cell, currentNode, nodeValues, evDisplayBasis]);

  const handByCombo = useMemo(() => {
    const map = new Map<
      string,
      { combo: string; actions: Array<{ action: string; probability: number }> }
    >();
    if (!cell) {
      return map;
    }
    for (const hand of cell.hands) {
      map.set(comboKey(hand.combo), hand);
    }
    return map;
  }, [cell]);

  const ev =
    cell && currentNode
      ? groupEv(currentNode, nodeValues, cell, evDisplayBasis)
      : null;
  const pinned = Boolean(selectedCell);
  const actions = currentNode?.actions ?? [];
  const evReady = Boolean(nodeValues && !nodeValues.pending);
  const shape = cell ? cellShape(cell.row, cell.col) : "pair";
  const cols = shapeColumns(shape);

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
          <div
            className="inspector-combos hands-combo-grid"
            data-shape={shape}
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
          >
            {squares.map((square) => {
              const hand = handByCombo.get(comboKey(square.combo));
              const handIndex = currentNode
                ? (() => {
                    const key = comboKey(square.combo);
                    const exact = handIndexForCombo(currentNode.combos, square.combo);
                    if (exact >= 0) {
                      return exact;
                    }
                    return (currentNode.combos || []).findIndex(
                      (entry) => comboKey(entry) === key,
                    );
                  })()
                : -1;
              const locked =
                handIndex >= 0 ? isHandLocked(nodeLock, handIndex) : false;
              const inDraft =
                handIndex >= 0 && lockDraft.handIndices.includes(handIndex);
              const actionEvs = square.present
                ? comboActionEvs(
                    currentNode,
                    nodeValues,
                    square.combo,
                    evDisplayBasis,
                  )
                : null;
              return (
                <div
                  key={square.combo}
                  className="inspector-combo hands-combo"
                  data-present={square.present ? "true" : "false"}
                  data-locked={locked ? "true" : "false"}
                  data-lock-draft={inDraft ? "true" : "false"}
                >
                  {square.present ? (
                    <input
                      type="checkbox"
                      checked={inDraft}
                      disabled={handIndex < 0}
                      onChange={() => {
                        if (handIndex >= 0) {
                          toggleLockHand(handIndex);
                        }
                      }}
                      aria-label={`Select ${square.combo} for lock`}
                      title="Include in lock draft"
                    />
                  ) : (
                    <span className="hands-combo__check-spacer" aria-hidden />
                  )}
                  <code className="hands-combo__code" title={square.combo}>
                    {square.label}
                  </code>
                  <div className="inspector-combo__mix hands-combo__mix">
                    {hand?.actions.map((action) => (
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
                          key={`${square.combo}-ev-${index}`}
                          className="hands-combo__ev tabular"
                          title={label}
                        >
                          {!square.present || value == null
                            ? "—"
                            : value.toFixed(2)}
                        </span>
                      );
                    })}
                  </div>
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
