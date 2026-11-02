import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { mapActionColors } from "../../domain/actionColors";
import {
  type AggregatedHandCell,
  formatRangeInclusion,
  frequencyOf,
  groupEv,
  groupHands,
  hasWithinHandActionMixing,
  isExcludedMatrixCell,
  RANGE_INCLUSION_MEASURE,
  rangeInclusionOf,
  strategyMix,
} from "../../domain/browse";
import {
  RANKS,
  type ActionValuesPayload,
  type EvDisplayBasis,
  type FrequencyMode,
  type MatrixMode,
  type NodePayload,
} from "../../domain/types";
import { useStudyStore } from "../../state/studyStore";
import "../../styles/matrix-density.css";

function cellKey(row: number, col: number): string {
  return `${row}:${col}`;
}

/** Fit a square matrix into the wrap's measured box (shared with opponent pane). */
export function useMeasuredSquareSide(
  wrapRef: RefObject<HTMLElement | null>,
): number {
  const [side, setSide] = useState(0);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) {
      return;
    }
    const measure = () => {
      const next = Math.max(0, Math.floor(Math.min(el.clientWidth, el.clientHeight)));
      setSide((prev) => (prev === next ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [wrapRef]);

  return side;
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
  return mode === "range" || mode === "action-range" || mode === "equity";
}

export function RangeMatrix() {
  const currentNode = useStudyStore((s) => s.currentNode);
  const nodeValues = useStudyStore((s) => s.nodeValues);
  const matrixMode = useStudyStore((s) => s.matrixMode);
  const frequencyMode = useStudyStore((s) => s.frequencyMode);
  const evDisplayBasis = useStudyStore((s) => s.evDisplayBasis);
  const selectedCell = useStudyStore((s) => s.selectedCell);
  const hoverCell = useStudyStore((s) => s.hoverCell);
  const setSelectedCell = useStudyStore((s) => s.setSelectedCell);
  const setHoverCell = useStudyStore((s) => s.setHoverCell);
  const actionFilter = useStudyStore((s) => s.actionFilter);
  const wrapRef = useRef<HTMLDivElement>(null);
  const side = useMeasuredSquareSide(wrapRef);

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
    <div className="range-matrix-wrap" ref={wrapRef}>
      <div
        className="range-matrix matrix-density"
        role="grid"
        aria-label={matrixAria}
        style={side > 0 ? { width: side, height: side } : undefined}
        onMouseLeave={() => setHoverCell(null)}
      >
        <div className="matrix-corner" />
        {RANKS.map((rank) => (
          <div key={`c-${rank}`} className="matrix-axis">
            {rank}
          </div>
        ))}
        {RANKS.map((rowRank, row) => (
          <MatrixRow
            key={`r-${rowRank}`}
            row={row}
            byKey={byKey}
            colors={colors.byIndex}
            matrixMode={matrixMode}
            frequencyMode={frequencyMode}
            selectedCell={selectedCell}
            hoverCell={hoverCell}
            actionFilter={actionFilter}
            currentNode={currentNode}
            nodeValues={nodeValues}
            evDisplayBasis={evDisplayBasis}
            evScale={evScale}
            setSelectedCell={setSelectedCell}
            setHoverCell={setHoverCell}
          />
        ))}
      </div>
    </div>
  );
}

interface Selected {
  row: number;
  col: number;
  text: string;
}

interface RowProps {
  row: number;
  byKey: Map<string, AggregatedHandCell>;
  colors: string[];
  matrixMode: MatrixMode;
  frequencyMode: FrequencyMode;
  selectedCell: Selected | null;
  hoverCell: Selected | null;
  actionFilter: number | null;
  currentNode: NodePayload | null;
  nodeValues: ActionValuesPayload | null;
  evDisplayBasis: EvDisplayBasis;
  evScale: number;
  setSelectedCell: (cell: Selected | null) => void;
  setHoverCell: (cell: Selected | null) => void;
}

function MatrixRow({
  row,
  byKey,
  colors,
  matrixMode,
  frequencyMode,
  selectedCell,
  hoverCell,
  actionFilter,
  currentNode,
  nodeValues,
  evDisplayBasis,
  evScale,
  setSelectedCell,
  setHoverCell,
}: RowProps) {
  return (
    <>
      <div className="matrix-axis">{RANKS[row]}</div>
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

        if (!empty && cell) {
          const showStrategy =
            matrixMode === "strategy" || matrixMode === "strategy-ev";
          if (showStrategy) {
            const mix = strategyMix(cell);
            if (mix) {
              segments = mix.map((weight, index) => ({
                color: colors[index] || "#666",
                weight,
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
              solid = evFill(ev.mixed, evScale);
              sub = ev.mixed.toFixed(1);
            } else {
              solid = "var(--secondary)";
              sub = "—";
            }
          } else if (matrixMode === "action-range" || matrixMode === "equity") {
            const freq = frequencyOf(cell, frequencyMode);
            if (freq != null) {
              solid = rangeFill(freq);
              sub = `${(freq * 100).toFixed(0)}`;
              partialInclusion = freq > 1e-6 && freq < 1 - 1e-6;
            }
          } else if (matrixMode === "strategy-ev") {
            const ev = groupEv(currentNode, nodeValues, cell, evDisplayBasis);
            if (ev) {
              sub = ev.mixed.toFixed(1);
            }
          }

          if (actionFilter != null && cell.actionMass.length) {
            const share =
              cell.marginalSum > 0
                ? cell.actionMass[actionFilter] / cell.marginalSum
                : 0;
            dimmed = share < 0.02;
            filtered = share >= 0.02;
            if (showStrategy) {
              sub = `${(share * 100).toFixed(0)}%`;
            }
          }
        }

        // Partial-inclusion chrome is only for solid weight fills, never mix bars.
        if (actionMixing || !usesRangeWeightFill(matrixMode)) {
          partialInclusion = false;
        }

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
            data-measure={measure}
            style={solid ? { background: solid } : undefined}
            onMouseEnter={() => setHoverCell({ row, col, text })}
            onClick={() => setSelectedCell({ row, col, text })}
            title={title}
          >
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
