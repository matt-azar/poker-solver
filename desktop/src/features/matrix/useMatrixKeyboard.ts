import { useCallback, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { RANKS } from "../../domain/types";

export interface MatrixFocusCell {
  row: number;
  col: number;
  text: string;
}

function cellText(row: number, col: number): string {
  if (row === col) {
    return `${RANKS[row]}${RANKS[col]}`;
  }
  if (row < col) {
    return `${RANKS[row]}${RANKS[col]}s`;
  }
  return `${RANKS[col]}${RANKS[row]}o`;
}

function clampIndex(value: number): number {
  return Math.max(0, Math.min(RANKS.length - 1, value));
}

/**
 * One Tab stop on the 13×13: arrows move by rank, Enter pins, Escape clears.
 */
export function useMatrixKeyboard(opts: {
  selectedCell: MatrixFocusCell | null;
  setSelectedCell: (cell: MatrixFocusCell | null) => void;
  focusCell: MatrixFocusCell | null;
  setFocusCell: (cell: MatrixFocusCell | null) => void;
}) {
  const { selectedCell, setSelectedCell, focusCell, setFocusCell } = opts;

  const ensureFocus = useCallback((): MatrixFocusCell => {
    if (focusCell) {
      return focusCell;
    }
    if (selectedCell) {
      setFocusCell(selectedCell);
      return selectedCell;
    }
    const next = { row: 0, col: 0, text: cellText(0, 0) };
    setFocusCell(next);
    return next;
  }, [focusCell, selectedCell, setFocusCell]);

  const onGridKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      const key = event.key;
      if (
        key !== "ArrowUp" &&
        key !== "ArrowDown" &&
        key !== "ArrowLeft" &&
        key !== "ArrowRight" &&
        key !== "Enter" &&
        key !== "Escape" &&
        key !== " "
      ) {
        return;
      }
      event.preventDefault();
      if (key === "Escape") {
        setSelectedCell(null);
        setFocusCell(null);
        return;
      }
      const current = ensureFocus();
      if (key === "Enter" || key === " ") {
        setSelectedCell(current);
        return;
      }
      let row = current.row;
      let col = current.col;
      if (key === "ArrowUp") {
        row = clampIndex(row - 1);
      } else if (key === "ArrowDown") {
        row = clampIndex(row + 1);
      } else if (key === "ArrowLeft") {
        col = clampIndex(col - 1);
      } else if (key === "ArrowRight") {
        col = clampIndex(col + 1);
      }
      setFocusCell({ row, col, text: cellText(row, col) });
    },
    [ensureFocus, setFocusCell, setSelectedCell],
  );

  return { onGridKeyDown, cellText };
}
