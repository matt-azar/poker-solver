import { useMemo } from "react";
import { mapActionColors } from "../../domain/actionColors";
import { groupHands, withEvBasis } from "../../domain/browse";
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

function squareMass(square: ComboBreakdownSquare): number {
  if (square.reach != null && Number.isFinite(square.reach)) {
    return Math.max(0, square.reach);
  }
  if (square.marginal != null && Number.isFinite(square.marginal)) {
    return Math.max(0, square.marginal);
  }
  return square.present ? 1 : 0;
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

  const maxMass = useMemo(() => {
    let peak = 0;
    for (const square of squares) {
      peak = Math.max(peak, squareMass(square));
    }
    return peak;
  }, [squares]);

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
              const actionEvs = square.present
                ? comboActionEvs(
                    currentNode,
                    nodeValues,
                    square.combo,
                    evDisplayBasis,
                  )
                : null;
              const mass = squareMass(square);
              const massFill =
                square.present && maxMass > 0
                  ? Math.max(0, Math.min(1, mass / maxMass))
                  : 0;
              const segments = (hand?.actions ?? []).filter(
                (action) => action.probability > 0.001,
              );
              return (
                <div
                  key={square.combo}
                  className="inspector-combo hands-combo"
                  data-present={square.present ? "true" : "false"}
                  style={{ ["--mass-fill" as string]: String(massFill) }}
                  title={square.combo}
                >
                  <div className="hands-combo__weight-fill">
                    {segments.length > 0 ? (
                      <div className="hands-combo__segments">
                        {segments.map((action) => (
                          <span
                            key={action.action}
                            className="hands-combo__seg"
                            title={`${action.action} ${(action.probability * 100).toFixed(0)}%`}
                            style={{
                              flexGrow: action.probability,
                              flexBasis: 0,
                              background: colors.byLabel[action.action] || "#666",
                            }}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <div className="hands-combo__body">
                    <code className="hands-combo__code" title={square.combo}>
                      {square.label}
                    </code>
                    <div className="hands-combo__evs">
                      {actions.map((label, index) => {
                        const value = actionEvs?.[index];
                        return (
                          <span
                            key={`${square.combo}-ev-${index}`}
                            className="hands-combo__ev tabular"
                            title={label}
                            style={{ color: colors.byIndex[index] }}
                          >
                            {!square.present || value == null
                              ? "—"
                              : value.toFixed(2)}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {pinned ? (
            <div className="combo-inspector__unpin">
              <button
                type="button"
                className="toolbar-btn"
                onClick={() => setSelectedCell(null)}
              >
                Clear selection
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
