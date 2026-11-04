import { useMemo, type CSSProperties } from "react";
import {
  type AggregatedHandCell,
  formatRangeInclusion,
  rangeInclusionOf,
} from "../../domain/browse";
import {
  cellShape,
  comboBreakdown,
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
  type NodePayload,
} from "../../domain/types";

interface Props {
  cell: AggregatedHandCell;
  node: NodePayload;
  nodeValues: ActionValuesPayload | null;
  evDisplayBasis: EvDisplayBasis;
  equityMap: Map<string, number>;
  pinned: boolean;
  /** Viewport (fixed) or wrap-relative anchor for the hovered / pinned cell. */
  anchor: {
    left: number;
    top: number;
    width: number;
    height: number;
    /** When true, `left`/`top` are viewport coordinates (position:fixed). */
    viewport?: boolean;
  } | null;
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

/** Pio-style floating suit-pair breakdown for a hovered / pinned 169-cell. */
export function ComboHoverPopup({
  cell,
  node,
  nodeValues,
  evDisplayBasis,
  equityMap,
  pinned,
  anchor,
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

  const style = positionStyle(anchor);

  return (
    <div
      className="combo-hover-popup"
      role="dialog"
      aria-label={`${cell.text} combo breakdown`}
      data-pinned={pinned ? "true" : "false"}
      data-shape={shape}
      style={style}
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
          <MiniSquare key={square.combo} square={square} overlay={overlay} />
        ))}
      </div>
    </div>
  );
}

function MiniSquare({
  square,
  overlay,
}: {
  square: ComboBreakdownSquare;
  overlay: MatrixCellOverlay;
}) {
  const weight =
    square.reach != null
      ? square.reach
      : square.marginal != null
        ? square.marginal
        : null;
  const fillPct =
    weight != null ? `${Math.max(0, Math.min(1, weight)) * 100}%` : "0%";
  const showEv = overlay === "ev" || overlay === "both";
  const showEq = overlay === "equity" || overlay === "both";

  return (
    <div
      className="combo-hover-square"
      data-present={square.present ? "true" : "false"}
      data-empty={!square.present || !(weight != null && weight > 0)}
      title={square.combo}
    >
      <div className="combo-hover-square__fill" style={{ height: fillPct }} />
      <div className="combo-hover-square__body">
        <span className="combo-hover-square__label">{square.label}</span>
        <span className="combo-hover-square__weight tabular">
          {weight == null ? "—" : formatRangeInclusion(weight)}
        </span>
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

function positionStyle(anchor: Props["anchor"]): CSSProperties | undefined {
  if (!anchor) {
    return undefined;
  }
  const gap = 8;
  const preferRight = anchor.left + anchor.width + gap;
  const top = Math.max(4, anchor.top);
  if (anchor.viewport) {
    const maxLeft =
      typeof window !== "undefined"
        ? Math.max(8, window.innerWidth - 200)
        : preferRight;
    return {
      position: "fixed",
      left: Math.min(preferRight, maxLeft),
      top: Math.min(top, typeof window !== "undefined" ? window.innerHeight - 80 : top),
      zIndex: 40,
    };
  }
  return {
    position: "absolute",
    left: preferRight,
    top,
  };
}
