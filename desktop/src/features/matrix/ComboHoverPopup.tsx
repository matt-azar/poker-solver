import { useMemo } from "react";
import {
  type AggregatedHandCell,
  formatRangeInclusion,
  rangeInclusionOf,
} from "../../domain/browse";
import {
  cellShape,
  comboBreakdown,
  comboHoverPaint,
  comboHoverShowEquity,
  comboHoverShowEv,
  formatEquityPct,
  formatEvChip,
  type ComboBreakdownSquare,
  type MatrixCellOverlay,
  useMatrixDisplayStore,
} from "../../domain/matrixDisplay";
import {
  RANKS,
  type ActionValuesPayload,
  type EvDisplayBasis,
  type MatrixMode,
  type NodePayload,
} from "../../domain/types";

interface Props {
  cell: AggregatedHandCell;
  node: NodePayload;
  nodeValues: ActionValuesPayload | null;
  evDisplayBasis: EvDisplayBasis;
  equityMap: Map<string, number>;
  pinned: boolean;
  matrixMode: MatrixMode;
  /** Action colors aligned with node.actions indices. */
  actionColors: string[];
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

/**
 * Pio-style suit-pair breakdown docked beside the matrix (not over cells).
 * Paint follows the main grid mode: strategy mix, range weight, or EV.
 */
export function ComboHoverPopup({
  cell,
  node,
  nodeValues,
  evDisplayBasis,
  equityMap,
  pinned,
  matrixMode,
  actionColors,
}: Props) {
  const overlay = useMatrixDisplayStore((s) => s.prefs.cellOverlay);
  const squares = useMemo(
    () =>
      comboBreakdown(cell, node, nodeValues, equityMap, evDisplayBasis, RANKS),
    [cell, node, nodeValues, equityMap, evDisplayBasis],
  );
  const shape = cellShape(cell.row, cell.col);
  const cols = shapeColumns(shape);
  const inclusion = rangeInclusionOf(cell);
  const paint = comboHoverPaint(matrixMode);
  const showEv = comboHoverShowEv(matrixMode, overlay);
  const showEq = comboHoverShowEquity(matrixMode, overlay);

  return (
    <aside
      className="combo-hover-popup"
      role="dialog"
      aria-label={`${cell.text} combo breakdown`}
      data-pinned={pinned ? "true" : "false"}
      data-shape={shape}
      data-paint={paint}
    >
      <div className="combo-hover-popup__header">
        <strong>{cell.text}</strong>
        <span className="muted tabular">
          {inclusion == null ? "—" : `${formatRangeInclusion(inclusion)}%`}
        </span>
        <span className="muted">{pinned ? "Pinned" : "Hover"}</span>
      </div>
      <div
        className="combo-hover-popup__grid"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {squares.map((square) => (
          <MiniSquare
            key={square.combo}
            square={square}
            paint={paint}
            showEv={showEv}
            showEq={showEq}
            overlay={overlay}
            actionColors={actionColors}
          />
        ))}
      </div>
    </aside>
  );
}

function MiniSquare({
  square,
  paint,
  showEv,
  showEq,
  overlay,
  actionColors,
}: {
  square: ComboBreakdownSquare;
  paint: ReturnType<typeof comboHoverPaint>;
  showEv: boolean;
  showEq: boolean;
  overlay: MatrixCellOverlay;
  actionColors: string[];
}) {
  const weight =
    square.reach != null
      ? square.reach
      : square.marginal != null
        ? square.marginal
        : null;
  const empty =
    !square.present ||
    (paint === "range" && !(weight != null && weight > 0)) ||
    (paint === "strategy" &&
      (!square.strategy || !square.strategy.some((w) => w > 0.001)));

  void overlay;

  return (
    <div
      className="combo-hover-square"
      data-present={square.present ? "true" : "false"}
      data-empty={empty ? "true" : "false"}
      data-paint={paint}
      title={square.combo}
    >
      {paint === "strategy" && square.strategy ? (
        <div className="combo-hover-square__segments" aria-hidden>
          {square.strategy.map((seg, index) =>
            seg > 0.001 ? (
              <span
                key={index}
                className="combo-hover-square__seg"
                style={{
                  flexGrow: seg,
                  flexBasis: 0,
                  background: actionColors[index] || "#666",
                }}
              />
            ) : null,
          )}
        </div>
      ) : null}
      {paint === "range" ? (
        <div
          className="combo-hover-square__fill"
          style={{
            height:
              weight != null
                ? `${Math.max(0, Math.min(1, weight)) * 100}%`
                : "0%",
          }}
        />
      ) : null}
      {paint === "ev" ? (
        <div
          className="combo-hover-square__ev-fill"
          data-sign={
            square.ev == null || !Number.isFinite(square.ev)
              ? "none"
              : square.ev >= 0
                ? "pos"
                : "neg"
          }
        />
      ) : null}
      <div className="combo-hover-square__body">
        <span className="combo-hover-square__label">{square.label}</span>
        {paint === "range" ? (
          <span className="combo-hover-square__weight tabular">
            {weight == null ? "—" : formatRangeInclusion(weight)}
          </span>
        ) : null}
        {showEv ? (
          <span className="combo-hover-square__meta tabular">
            {formatEvChip(square.ev)}
          </span>
        ) : null}
        {showEq ? (
          <span className="combo-hover-square__meta tabular">
            {square.equity == null ? "—" : formatEquityPct(square.equity)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Empty dock placeholder when nothing is hovered / pinned. */
export function ComboHoverDockEmpty() {
  return (
    <aside className="combo-hover-popup combo-hover-popup--empty" aria-hidden>
      <p className="muted">Hover a hand</p>
    </aside>
  );
}
