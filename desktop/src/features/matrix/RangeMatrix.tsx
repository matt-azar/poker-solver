import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { mapActionColors } from "../../domain/actionColors";
import { orderActionIndicesByAggression } from "../../domain/actionOrder";
import {
  type AggregatedHandCell,
  formatRangeInclusion,
  groupEv,
  groupHands,
  hasWithinHandActionMixing,
  isExcludedMatrixCell,
  RANGE_INCLUSION_MEASURE,
  rangeInclusionOf,
  strategyMix,
} from "../../domain/browse";
import {
  equityByCombo,
  equityHandsForNode,
  formatEvChip,
  groupEquity,
  overlaySubLabel,
  useMatrixDisplayStore,
  weightFillFraction,
} from "../../domain/matrixDisplay";
import {
  RANKS,
  type ActionValuesPayload,
  type EvDisplayBasis,
  type MatrixMode,
  type NodePayload,
} from "../../domain/types";
import { clampDockHeight } from "../../state/layoutStore";
import { useSettingsStore } from "../../state/settingsStore";
import { useStudyStore } from "../../state/studyStore";
import "../../styles/matrix-density.css";

function cellKey(row: number, col: number): string {
  return `${row}:${col}`;
}

/**
 * Width ÷ height for the study matrix when the opponent grid is hidden.
 * Dual-range keeps both grids square (ratio 1). Cell type: matrix-density.css.
 */
export const SINGLE_MATRIX_WIDTH_OVER_HEIGHT = 1.5;

/**
 * Fit a `widthOverHeight` box into the measured stage.
 * Square (ratio 1): largest square on the shorter side (dual / opponent).
 * Non-square: fill height first so there is no empty vertical gap; width follows
 * the aspect when the stage is wide enough, otherwise uses the full stage width.
 */
export function fitAspectSize(
  boxWidth: number,
  boxHeight: number,
  widthOverHeight: number,
): { width: number; height: number } {
  const ratio = widthOverHeight > 0 ? widthOverHeight : 1;
  const bw = Math.max(0, boxWidth);
  const bh = Math.max(0, boxHeight);
  if (ratio === 1) {
    const side = Math.floor(Math.min(bw, bh));
    return { width: side, height: side };
  }
  const height = Math.floor(bh);
  const width = Math.floor(Math.min(bw, height * ratio));
  return { width: Math.max(0, width), height: Math.max(0, height) };
}

/** Fit a width/height box into the wrap (opponent pane stays square). */
function useMeasuredAspectSize(
  wrapRef: RefObject<HTMLElement | null>,
  widthOverHeight: number,
): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) {
      return;
    }
    const measure = () => {
      const next = fitAspectSize(el.clientWidth, el.clientHeight, widthOverHeight);
      setSize((prev) =>
        prev.width === next.width && prev.height === next.height ? prev : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [wrapRef, widthOverHeight]);

  return size;
}

/** Fit a square matrix into the wrap's measured box (shared with opponent pane). */
export function useMeasuredSquareSide(
  wrapRef: RefObject<HTMLElement | null>,
): number {
  return useMeasuredAspectSize(wrapRef, 1).width;
}

function rangeFill(weight: number): string {
  const t = Math.max(0, Math.min(1, weight));
  const r = Math.round(36 + (46 - 36) * t);
  const g = Math.round(92 + (148 - 92) * t);
  const b = Math.round(52 + (102 - 52) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

function evFill(value: number, scale: number): string {
  if (!(scale > 0)) {
    return "var(--secondary)";
  }
  const t = Math.max(-1, Math.min(1, value / scale));
  if (t >= 0) {
    const a = Math.round(t * 180);
    return `rgb(${40 + a}, ${110 + Math.round(t * 40)}, ${70})`;
  }
  const a = Math.round(-t * 160);
  return `rgb(${160 + a}, ${70}, ${65})`;
}

function equityFill(equity: number): string {
  const t = Math.max(0, Math.min(1, equity));
  const r = Math.round(40 + (36 - 40) * t);
  const g = Math.round(70 + (120 - 70) * t);
  const b = Math.round(110 + (160 - 110) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

function maxAbsEv(
  cells: AggregatedHandCell[],
  node: NodePayload,
  values: ActionValuesPayload,
  basis: EvDisplayBasis,
): number {
  let max = 0;
  for (const cell of cells) {
    const ev = groupEv(node, values, cell, basis);
    if (ev) {
      max = Math.max(max, Math.abs(ev.mixed));
    }
  }
  return max || 1;
}

function usesRangeWeightFill(mode: MatrixMode): boolean {
  return mode === "range";
}

export function RangeMatrix() {
  const currentNode = useStudyStore((s) => s.currentNode);
  const nodeValues = useStudyStore((s) => s.nodeValues);
  const matrixMode = useStudyStore((s) => s.matrixMode);
  // Settings is the authority for local vs global EV display.
  const evDisplayBasis = useSettingsStore((s) => s.settings.evDisplayBasis);
  const selectedCell = useStudyStore((s) => s.selectedCell);
  const hoverCell = useStudyStore((s) => s.hoverCell);
  const setSelectedCell = useStudyStore((s) => s.setSelectedCell);
  const setHoverCell = useStudyStore((s) => s.setHoverCell);
  const actionFilter = useStudyStore((s) => s.actionFilter);
  const equity = useStudyStore((s) => s.equity);
  const displayPrefs = useMatrixDisplayStore((s) => s.prefs);
  const dualRange = useStudyStore((s) => s.layout.dualRange);
  const matrixWidth = useStudyStore((s) => s.layout.matrixWidth);
  const lowerDockOpen = useStudyStore((s) => s.layout.lowerDock);
  const lowerDockHeight = useStudyStore((s) => s.layout.lowerDockHeight);
  const setLayout = useStudyStore((s) => s.setLayout);
  const userWidth =
    typeof matrixWidth === "number" && matrixWidth > 0 ? matrixWidth : null;
  const stageRef = useRef<HTMLDivElement>(null);
  const size = useMeasuredAspectSize(
    stageRef,
    dualRange ? 1 : SINGLE_MATRIX_WIDTH_OVER_HEIGHT,
  );

  const onResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const wrap = event.currentTarget.parentElement;
    const stage = wrap?.closest(".matrix-stage");
    const startX = event.clientX;
    const measured = wrap?.getBoundingClientRect().width ?? 0;
    const startW = measured > 0 ? measured : (userWidth ?? 0);
    const stageWidth = stage?.getBoundingClientRect().width ?? 0;
    const max = stageWidth > 480 ? Math.max(180, stageWidth - 280) : 1400;
    const onMove = (ev: PointerEvent) => {
      const next = Math.min(max, Math.max(180, startW + (ev.clientX - startX)));
      setLayout({ matrixWidth: Math.round(next) });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const cells = useMemo(
    () => (currentNode ? groupHands(currentNode) : []),
    [currentNode],
  );

  const byKey = useMemo(() => {
    const map = new Map<string, AggregatedHandCell>();
    for (const cell of cells) {
      map.set(cellKey(cell.row, cell.col), cell);
    }
    return map;
  }, [cells]);

  const equityMap = useMemo(() => {
    const hands = equityHandsForNode(
      equity as { pending?: boolean; oop_hands?: Array<{ combo: string; equity: number }>; ip_hands?: Array<{ combo: string; equity: number }> } | null,
      currentNode?.player,
    );
    return equityByCombo(hands);
  }, [equity, currentNode?.player]);

  const actions = currentNode?.actions;
  const colors = useMemo(() => mapActionColors(actions ?? []), [actions]);

  const evScale = useMemo(() => {
    if (!currentNode || !nodeValues || nodeValues.pending) {
      return 1;
    }
    return maxAbsEv(cells, currentNode, nodeValues, evDisplayBasis);
  }, [cells, currentNode, nodeValues, evDisplayBasis]);

  const matrixAria =
    matrixMode === "range"
      ? `Hand range matrix (${RANGE_INCLUSION_MEASURE})`
      : "Hand range matrix";

  return (
    <div
      className="range-matrix-wrap"
      style={
        userWidth
          ? {
              width: userWidth,
              maxWidth: "100%",
              flex: "0 0 auto",
              aspectRatio: "auto",
              height: "100%",
            }
          : undefined
      }
    >
      <div className="range-matrix-stage" ref={stageRef}>
        <div
          className="range-matrix matrix-density range-matrix--no-axis"
          role="grid"
          aria-label={matrixAria}
          style={
            userWidth
              ? { width: "100%", height: "100%" }
              : size.width > 0
                ? { width: size.width, height: size.height }
                : undefined
          }
          onMouseLeave={() => setHoverCell(null)}
        >
          {RANKS.map((rowRank, row) => (
            <MatrixRow
              key={`r-${rowRank}`}
              row={row}
              byKey={byKey}
              colors={colors.byIndex}
              matrixMode={matrixMode}
              selectedCell={selectedCell}
              hoverCell={hoverCell}
              actionFilter={actionFilter}
              currentNode={currentNode}
              nodeValues={nodeValues}
              evDisplayBasis={evDisplayBasis}
              evScale={evScale}
              equityMap={equityMap}
              displayPrefs={displayPrefs}
              setSelectedCell={setSelectedCell}
              setHoverCell={setHoverCell}
            />
          ))}
        </div>
      </div>
      <div
        className="resize-handle resize-handle--vertical range-matrix__resize"
        style={
          lowerDockOpen
            ? { bottom: clampDockHeight(lowerDockHeight) }
            : undefined
        }
        onPointerDown={onResizePointerDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize range matrix"
        title="Drag to resize the range grid"
      />
    </div>
  );
}

interface Selected {
  row: number;
  col: number;
  text: string;
}

interface DisplayPrefs {
  rangeWeightHeightFill: boolean;
  cellOverlay: "none" | "ev" | "equity" | "both";
  colorByOverlay: boolean;
}

interface RowProps {
  row: number;
  byKey: Map<string, AggregatedHandCell>;
  colors: string[];
  matrixMode: MatrixMode;
  selectedCell: Selected | null;
  hoverCell: Selected | null;
  actionFilter: number | null;
  currentNode: NodePayload | null;
  nodeValues: ActionValuesPayload | null;
  evDisplayBasis: EvDisplayBasis;
  evScale: number;
  equityMap: Map<string, number>;
  displayPrefs: DisplayPrefs;
  setSelectedCell: (cell: Selected | null) => void;
  setHoverCell: (cell: Selected | null) => void;
}

function MatrixRow({
  row,
  byKey,
  colors,
  matrixMode,
  selectedCell,
  hoverCell,
  actionFilter,
  currentNode,
  nodeValues,
  evDisplayBasis,
  evScale,
  equityMap,
  displayPrefs,
  setSelectedCell,
  setHoverCell,
}: RowProps) {
  return (
    <>
      {RANKS.map((_, col) => {
        const cell = byKey.get(cellKey(row, col));
        const text =
          cell?.text ??
          (row === col
            ? `${RANKS[row]}${RANKS[col]}`
            : row < col
              ? `${RANKS[row]}${RANKS[col]}s`
              : `${RANKS[col]}${RANKS[row]}o`);
        const inclusion = cell ? rangeInclusionOf(cell) : null;
        const excluded =
          matrixMode === "range"
            ? !cell || !cell.defined || inclusion == null || inclusion <= 0
            : isExcludedMatrixCell(cell);
        const empty = excluded;
        const selected = selectedCell?.row === row && selectedCell?.col === col;
        const hovered = hoverCell?.row === row && hoverCell?.col === col;

        let sub = "";
        let segments: Array<{ color: string; weight: number }> = [];
        let solid: string | null = null;
        let dimmed = false;
        let filtered = false;
        let partialInclusion = false;
        let actionMixing = false;
        let measure: string | undefined;
        let title = text;
        let cellEv: number | null = null;
        let cellEquity: number | null = null;

        if (!empty && cell) {
          const showStrategy =
            matrixMode === "strategy" || matrixMode === "strategy-ev";
          if (showStrategy) {
            const mix = strategyMix(cell);
            if (mix) {
              const actionLabels = currentNode?.actions ?? [];
              const order = orderActionIndicesByAggression(actionLabels);
              segments = order.map((index) => ({
                color: colors[index] || "#666",
                weight: mix[index] ?? 0,
              }));
            }
            actionMixing = hasWithinHandActionMixing(cell);
          }

          if (matrixMode === "range") {
            const weight = inclusion ?? 0;
            solid = rangeFill(weight);
            sub = formatRangeInclusion(weight);
            measure = "inclusion-weight";
            partialInclusion = weight > 1e-6 && weight < 1 - 1e-6;
            title = `${text} · ${RANGE_INCLUSION_MEASURE} ${formatRangeInclusion(weight)}%`;
          } else if (matrixMode === "ev") {
            const ev = groupEv(currentNode, nodeValues, cell, evDisplayBasis);
            if (ev) {
              cellEv = ev.mixed;
              solid = evFill(ev.mixed, evScale);
              sub = formatEvChip(ev.mixed);
            } else {
              solid = "var(--secondary)";
              sub = "—";
            }
          } else if (matrixMode === "strategy-ev") {
            const ev = groupEv(currentNode, nodeValues, cell, evDisplayBasis);
            if (ev) {
              cellEv = ev.mixed;
              sub = formatEvChip(ev.mixed);
            }
          }

          if (
            displayPrefs.cellOverlay !== "none" &&
            (displayPrefs.cellOverlay === "ev" ||
              displayPrefs.cellOverlay === "both") &&
            cellEv == null
          ) {
            const ev = groupEv(currentNode, nodeValues, cell, evDisplayBasis);
            if (ev) {
              cellEv = ev.mixed;
            }
          }
          if (
            displayPrefs.cellOverlay === "equity" ||
            displayPrefs.cellOverlay === "both"
          ) {
            cellEquity = groupEquity(cell, equityMap, currentNode);
          }

          const overlaySub = overlaySubLabel(
            displayPrefs.cellOverlay,
            cellEv,
            cellEquity,
          );
          if (overlaySub) {
            // Additive overlay replaces mode sub when set (strategy colors stay).
            if (matrixMode === "strategy" || matrixMode === "strategy-ev") {
              sub = overlaySub;
            } else if (matrixMode === "range") {
              sub = overlaySub;
            } else if (matrixMode === "ev" && displayPrefs.cellOverlay !== "ev") {
              sub = overlaySub;
            }
          }

          if (
            displayPrefs.colorByOverlay &&
            displayPrefs.cellOverlay !== "none" &&
            segments.length === 0
          ) {
            if (
              (displayPrefs.cellOverlay === "ev" ||
                displayPrefs.cellOverlay === "both") &&
              cellEv != null
            ) {
              solid = evFill(cellEv, evScale);
            } else if (
              displayPrefs.cellOverlay === "equity" &&
              cellEquity != null
            ) {
              solid = equityFill(cellEquity);
            }
          }

          if (actionFilter != null && cell.actionMass.length) {
            const share =
              cell.marginalSum > 0
                ? cell.actionMass[actionFilter] / cell.marginalSum
                : 0;
            dimmed = share < 0.02;
            filtered = share >= 0.02;
            if (showStrategy && displayPrefs.cellOverlay === "none") {
              sub = `${(share * 100).toFixed(0)}%`;
            }
          }
        }

        // Partial-inclusion chrome is only for solid weight fills, never mix bars.
        if (actionMixing || !usesRangeWeightFill(matrixMode)) {
          partialInclusion = false;
        }

        const useHeightFill =
          displayPrefs.rangeWeightHeightFill &&
          !empty &&
          (matrixMode === "range" ||
            matrixMode === "strategy" ||
            matrixMode === "strategy-ev");
        // Prefer inclusion weight; if undefined on a live cell, keep full height.
        const fillFrac = weightFillFraction(
          useHeightFill,
          inclusion ?? (useHeightFill ? 1 : 0),
        );

        return (
          <button
            key={`${row}-${col}`}
            type="button"
            className="matrix-cell"
            role="gridcell"
            data-empty={empty}
            data-excluded={excluded}
            data-selected={selected}
            data-hover={hovered}
            data-dimmed={dimmed}
            data-filtered={filtered}
            data-partial-inclusion={partialInclusion}
            data-action-mixing={actionMixing}
            data-weight-fill={useHeightFill ? "true" : "false"}
            data-measure={measure}
            style={
              useHeightFill
                ? ({
                    ["--weight-fill" as string]: String(fillFrac),
                    background: "var(--empty-cell)",
                  } as CSSProperties)
                : solid
                  ? { background: solid }
                  : undefined
            }
            onMouseEnter={() => setHoverCell({ row, col, text })}
            onClick={() => setSelectedCell({ row, col, text })}
            title={title}
          >
            {useHeightFill ? (
              <div className="matrix-cell__weight-fill">
                {segments.length > 0 ? (
                  <div className="matrix-cell__segments">
                    {segments.map((seg, index) =>
                      seg.weight > 0.001 ? (
                        <span
                          key={index}
                          className="matrix-cell__seg"
                          style={{
                            flexGrow: seg.weight,
                            flexBasis: 0,
                            background: seg.color,
                          }}
                        />
                      ) : null,
                    )}
                  </div>
                ) : solid ? (
                  <div
                    className="matrix-cell__solid"
                    style={{ background: solid }}
                  />
                ) : null}
              </div>
            ) : segments.length > 0 ? (
              <div className="matrix-cell__segments">
                {segments.map((seg, index) =>
                  seg.weight > 0.001 ? (
                    <span
                      key={index}
                      className="matrix-cell__seg"
                      style={{
                        flexGrow: seg.weight,
                        flexBasis: 0,
                        background: seg.color,
                      }}
                    />
                  ) : null,
                )}
              </div>
            ) : null}
            <span className="matrix-cell__label">
              <span>{text}</span>
              {sub ? <span className="matrix-cell__sub">{sub}</span> : null}
            </span>
          </button>
        );
      })}
    </>
  );
}
