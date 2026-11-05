import { useRef } from "react";
import { RANKS } from "../../domain/types";
import { exactCellSummary, type ExactRange, type WeightGrid } from "../../domain/range";

function cellFromPoint(
  root: HTMLElement,
  clientX: number,
  clientY: number,
): { row: number; col: number } | null {
  const hit = document.elementFromPoint(clientX, clientY);
  const button = hit?.closest<HTMLElement>("[data-row][data-col]");
  if (!button || !root.contains(button)) {
    return null;
  }
  const row = Number(button.dataset.row);
  const col = Number(button.dataset.col);
  if (!Number.isInteger(row) || !Number.isInteger(col)) {
    return null;
  }
  return { row, col };
}

type Props = {
  label: string;
  weights: WeightGrid;
  exact: ExactRange;
  onPaint: (row: number, col: number) => void;
};

export function ControlledRangeGrid({ label, weights, exact, onPaint }: Props) {
  const gridRef = useRef<HTMLDivElement>(null);
  const paintingRef = useRef(false);

  const finishStroke = () => {
    paintingRef.current = false;
  };

  return (
    <div
      ref={gridRef}
      className="range-paint-grid"
      role="grid"
      aria-label={label}
      onPointerDown={(event) => {
        if (event.button !== 0 || !gridRef.current) {
          return;
        }
        const cell = cellFromPoint(gridRef.current, event.clientX, event.clientY);
        if (!cell) {
          return;
        }
        event.preventDefault();
        paintingRef.current = true;
        onPaint(cell.row, cell.col);
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!paintingRef.current || !gridRef.current) {
          return;
        }
        const cell = cellFromPoint(gridRef.current, event.clientX, event.clientY);
        if (!cell) {
          return;
        }
        onPaint(cell.row, cell.col);
      }}
      onPointerUp={finishStroke}
      onPointerCancel={finishStroke}
      onLostPointerCapture={finishStroke}
    >
      {RANKS.map((rowRank, row) =>
        RANKS.map((colRank, col) => {
          const weight = weights[row]![col]!;
          const summary = exactCellSummary(exact, row, col);
          const labelText =
            row === col
              ? `${rowRank}${colRank}`
              : row < col
                ? `${rowRank}${colRank}s`
                : `${colRank}${rowRank}o`;
          return (
            <button
              key={`${row}-${col}`}
              type="button"
              className="paint-cell"
              data-row={row}
              data-col={col}
              data-on={weight > 0}
              data-mixed={summary.mixed || undefined}
              style={
                weight > 0
                  ? {
                      background: `rgba(63, 143, 107, ${0.25 + 0.75 * Math.min(weight, 1)})`,
                    }
                  : undefined
              }
              title={
                summary.mixed
                  ? `${labelText} mixed ${summary.min.toFixed(2)}–${summary.max.toFixed(2)}`
                  : labelText
              }
              onClick={(event) => {
                if (event.detail !== 0) {
                  return;
                }
                onPaint(row, col);
              }}
            >
              {labelText}
            </button>
          );
        }),
      )}
    </div>
  );
}
