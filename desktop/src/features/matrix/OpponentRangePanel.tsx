import { useMemo, useRef } from "react";
import {
  type AggregatedHandCell,
  formatRangeInclusion,
  groupHands,
  opponentSolutionNode,
  RANGE_INCLUSION_MEASURE,
  rangeInclusionOf,
} from "../../domain/browse";
import { RANKS } from "../../domain/types";
import { useStudyStore } from "../../state/studyStore";
import "../../styles/matrix-density.css";
import "../../styles/opponent-range.css";
import { useMeasuredSquareSide } from "./RangeMatrix";

function rangeFill(weight: number): string {
  const t = Math.max(0, Math.min(1, weight));
  const r = Math.round(36 + (46 - 36) * t);
  const g = Math.round(92 + (148 - 92) * t);
  const b = Math.round(52 + (102 - 52) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

function cellKey(row: number, col: number): string {
  return `${row}:${col}`;
}

function seatLabel(player: number | null | undefined): string {
  if (player === 0) {
    return "OOP";
  }
  if (player === 1) {
    return "IP";
  }
  return "Opponent";
}

function handClassLabel(row: number, col: number): string {
  if (row === col) {
    return `${RANKS[row]}${RANKS[col]}`;
  }
  return row < col
    ? `${RANKS[row]}${RANKS[col]}s`
    : `${RANKS[col]}${RANKS[row]}o`;
}

/** Immutable solution snapshot for the non-acting seat (not Build draft weights). */
export function OpponentRangePanel() {
  const currentNode = useStudyStore((s) => s.currentNode);
  const view = useMemo(() => opponentSolutionNode(currentNode), [currentNode]);
  const cells = useMemo(() => (view ? groupHands(view) : []), [view]);
  const byKey = useMemo(() => {
    const map = new Map<string, AggregatedHandCell>();
    for (const cell of cells) {
      map.set(cellKey(cell.row, cell.col), cell);
    }
    return map;
  }, [cells]);
  const seat = seatLabel(view?.player ?? currentNode?.opponent_player);
  const wrapRef = useRef<HTMLDivElement>(null);
  const side = useMeasuredSquareSide(wrapRef);

  return (
    <section className="matrix-pane opponent-range-pane" aria-label={`${seat} range`}>
      <div className="panel-title-row">
        <h2 className="panel-title">{seat} range</h2>
      </div>
      {!view ? (
        <p className="empty-hint">Opponent reach appears on decision nodes.</p>
      ) : (
        <div className="range-matrix-wrap" ref={wrapRef}>
          <div
            className="range-matrix matrix-density"
            role="grid"
            aria-label={`${seat} solution range (${RANGE_INCLUSION_MEASURE})`}
            style={side > 0 ? { width: side, height: side } : undefined}
          >
            <div className="matrix-corner" />
            {RANKS.map((rank) => (
              <div key={`c-${rank}`} className="matrix-axis">
                {rank}
              </div>
            ))}
            {RANKS.map((rowRank, row) => (
              <div key={`r-${rowRank}`} className="matrix-row-fragment" style={{ display: "contents" }}>
                <div className="matrix-axis">{rowRank}</div>
                {RANKS.map((_, col) => {
                  const cell = byKey.get(cellKey(row, col));
                  const text = cell?.text ?? handClassLabel(row, col);
                  const inclusion = cell ? rangeInclusionOf(cell) : null;
                  const empty =
                    !cell || !cell.defined || inclusion == null || inclusion <= 0;
                  const weight = !empty ? (inclusion ?? 0) : 0;
                  const partialInclusion =
                    !empty && weight > 1e-6 && weight < 1 - 1e-6;
                  const sub = !empty ? formatRangeInclusion(weight) : "";
                  return (
                    <div
                      key={`${row}-${col}`}
                      className="matrix-cell"
                      role="gridcell"
                      data-empty={empty}
                      data-excluded={empty}
                      data-partial-inclusion={partialInclusion}
                      data-measure={!empty ? "inclusion-weight" : undefined}
                      style={!empty ? { background: rangeFill(weight) } : undefined}
                      title={
                        empty
                          ? text
                          : `${text} · ${RANGE_INCLUSION_MEASURE} ${sub}%`
                      }
                    >
                      <span className="matrix-cell__label">
                        <span className="matrix-cell__hand">{text}</span>
                        {sub ? (
                          <span className="matrix-cell__sub">{sub}</span>
                        ) : null}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
