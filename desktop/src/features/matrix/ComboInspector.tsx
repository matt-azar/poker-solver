/**
 * Hands panel — per-combo tiles for the hovered/selected hand class.
 *
 * Markup classes (.hands-combo*) are styled in styles/layout.css.
 * To change badge / metric type size, edit those CSS rules — not this file —
 * unless you need different content or structure.
 */
import { useMemo } from "react";
import { actionSizePotBasis } from "../../domain/actionHistory";
import { mapActionColors } from "../../domain/actionColors";
import { orderActionIndicesByAggression } from "../../domain/actionOrder";
import {
  formatActionDisplay,
  formatFrequencyPct,
} from "../../domain/betSizes";
import { groupHands, withEvBasis } from "../../domain/browse";
import {
  cellShape,
  comboBadgeCards,
  comboBreakdown,
  comboKey,
  equityByCombo,
  equityHandsForNode,
  formatEquityPct,
  formatEvChip,
  type ComboBreakdownSquare,
  type EquityPayloadLike,
  useMatrixDisplayStore,
  weightFillFraction,
} from "../../domain/matrixDisplay";
import type {
  ActionValuesPayload,
  EvDisplayBasis,
  NodePayload,
} from "../../domain/types";
import { RANKS } from "../../domain/types";
import { useSettingsStore } from "../../state/settingsStore";
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

function squareMass(square: ComboBreakdownSquare): number | null {
  if (square.reach != null && Number.isFinite(square.reach)) {
    return Math.max(0, square.reach);
  }
  if (square.marginal != null && Number.isFinite(square.marginal)) {
    // Posterior mass can exceed 1 across a node; clamp for height fill.
    return Math.max(0, Math.min(1, square.marginal));
  }
  return square.present ? 1 : null;
}

/** Hands list for the hovered/selected 169-cell in the Study detail panel. */
export function ComboInspector() {
  const currentNode = useStudyStore((s) => s.currentNode);
  const nodeValues = useStudyStore((s) => s.nodeValues);
  const equity = useStudyStore((s) => s.equity);
  const evDisplayBasis = useStudyStore((s) => s.evDisplayBasis);
  const selectedCell = useStudyStore((s) => s.selectedCell);
  const hoverCell = useStudyStore((s) => s.hoverCell);
  const calculateEv = useStudyStore((s) => s.calculateEv);
  const setSelectedCell = useStudyStore((s) => s.setSelectedCell);
  const status = useStudyStore((s) => s.status);
  const draft = useStudyStore((s) => s.draft);
  const displayPrefs = useMatrixDisplayStore((s) => s.prefs);
  const betSizeDisplay = useSettingsStore((s) => s.settings.betSizeDisplay);

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

  const equityMap = useMemo(() => {
    const hands = equityHandsForNode(
      equity as EquityPayloadLike | null,
      currentNode?.player,
    );
    return equityByCombo(hands);
  }, [equity, currentNode?.player]);

  const squares = useMemo(() => {
    if (!cell || !currentNode) {
      return [] as ComboBreakdownSquare[];
    }
    return comboBreakdown(
      cell,
      currentNode,
      nodeValues,
      equityMap,
      evDisplayBasis,
      RANKS,
    );
  }, [cell, currentNode, nodeValues, equityMap, evDisplayBasis]);

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
  const actionOrder = useMemo(
    () => orderActionIndicesByAggression(actions),
    [actions],
  );
  const pot = actionSizePotBasis(
    currentNode,
    Number(status?.pot ?? draft.pot ?? 0),
  );
  const toCall = Number(currentNode?.to_call ?? 0);
  const overlay = displayPrefs.cellOverlay;
  const showEv = overlay === "ev" || overlay === "both";
  const showEq = overlay === "equity" || overlay === "both";
  const showFreq = overlay === "none" || overlay === "equity";
  const weightFillOn = displayPrefs.rangeWeightHeightFill;
  const shape = cell ? cellShape(cell.row, cell.col) : "pair";
  const cols = shapeColumns(shape);
  // Action rows show EV or frequency; equity always has its own labeled row.
  const metricLabel = showEv ? "EV" : "Freq";

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
          <div
            className="inspector-combos hands-combo-grid"
            data-shape={shape}
            data-weight-fill={weightFillOn ? "true" : "false"}
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
              const massFill = weightFillFraction(
                weightFillOn,
                square.present ? (mass ?? 1) : 0,
              );
              const freqByLabel = new Map(
                (hand?.actions ?? []).map((entry) => [
                  entry.action,
                  entry.probability,
                ]),
              );
              const segments = actionOrder
                .map((index) => {
                  const label = actions[index]!;
                  const probability =
                    square.strategy?.[index] ?? freqByLabel.get(label) ?? 0;
                  return {
                    index,
                    label,
                    probability,
                    color: colors.byIndex[index] || "#666",
                  };
                })
                .filter((entry) => entry.probability > 0.001);
              const badgeCards = comboBadgeCards(square.combo);
              return (
                <div
                  key={square.combo}
                  className="inspector-combo hands-combo"
                  data-present={square.present ? "true" : "false"}
                  data-weight-fill={weightFillOn ? "true" : "false"}
                  style={{ ["--mass-fill" as string]: String(massFill) }}
                  title={square.combo}
                >
                  <div className="hands-combo__weight-fill">
                    {segments.length > 0 ? (
                      <div className="hands-combo__segments">
                        {segments.map((entry) => (
                          <span
                            key={entry.label}
                            className="hands-combo__seg"
                            title={`${entry.label} ${(entry.probability * 100).toFixed(0)}%`}
                            style={{
                              flexGrow: entry.probability,
                              flexBasis: 0,
                              background: entry.color,
                            }}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <div className="hands-combo__body">
                    <div className="hands-combo__top">
                      <span className="hands-combo__badge" title={square.combo}>
                        {badgeCards.length > 0
                          ? badgeCards.map((card, index) => (
                              <span
                                key={`${square.combo}-${index}`}
                                className="hands-combo__badge-card"
                                data-suit={card.suit}
                              >
                                <span className="hands-combo__badge-rank">
                                  {card.rank}
                                </span>
                                <span className="hands-combo__badge-suit">
                                  {card.symbol}
                                </span>
                              </span>
                            ))
                          : square.label}
                      </span>
                      <span className="hands-combo__metric-tag">{metricLabel}</span>
                    </div>
                    {square.present ? (
                      <div className="hands-combo__metrics">
                        {actionOrder.map((index) => {
                          const label = actions[index]!;
                          const display = formatActionDisplay(
                            label,
                            pot,
                            betSizeDisplay === "chips" ? "chips" : "pot",
                            { toCall },
                          );
                          const freq = freqByLabel.get(label) ?? 0;
                          let valueText = "—";
                          if (showEv) {
                            valueText = formatEvChip(actionEvs?.[index] ?? null);
                          } else if (showFreq) {
                            valueText = formatFrequencyPct(freq, 0) ?? "—";
                          }
                          return (
                            <div
                              key={`${square.combo}-metric-${index}`}
                              className="hands-combo__metric-row"
                            >
                              <span className="hands-combo__metric-action">
                                {display.primary}
                              </span>
                              <span className="hands-combo__metric-value tabular">
                                {valueText}
                              </span>
                            </div>
                          );
                        })}
                        {showEq ? (
                          <div className="hands-combo__metric-row hands-combo__metric-row--eq">
                            <span className="hands-combo__metric-action">Eq</span>
                            <span className="hands-combo__metric-value tabular">
                              {formatEquityPct(square.equity)}
                            </span>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
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
