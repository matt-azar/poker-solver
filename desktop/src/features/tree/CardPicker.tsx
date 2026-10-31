import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  CARD_RANKS,
  CARD_SUITS,
  chanceCardOptions,
  fullDeckGrid,
  type DeckCell,
} from "../../domain/cards";
import { useStudyStore } from "../../state/studyStore";

function isMissing(cell: DeckCell): cell is Extract<DeckCell, { missing: true }> {
  return "missing" in cell && cell.missing;
}

export function CardPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const currentNode = useStudyStore((s) => s.currentNode);
  const followAction = useStudyStore((s) => s.followAction);
  const [focusIndex, setFocusIndex] = useState(0);

  const options = useMemo(() => chanceCardOptions(currentNode), [currentNode]);
  const grid = useMemo(
    () => fullDeckGrid(options, currentNode?.board),
    [options, currentNode?.board],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    const firstLegal = grid.findIndex((cell) => !isMissing(cell) && !cell.blocked);
    setFocusIndex(firstLegal >= 0 ? firstLegal : 0);
  }, [open, grid]);

  const selectCell = useCallback(
    (cell: DeckCell) => {
      if (isMissing(cell) || cell.blocked) {
        return;
      }
      void followAction(cell.nodeId);
      onClose();
    },
    [followAction, onClose],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      const cols = CARD_SUITS.length;
      const rows = CARD_RANKS.length;
      const row = Math.floor(focusIndex / cols);
      const col = focusIndex % cols;
      let next = focusIndex;
      if (event.key === "ArrowRight") {
        next = row * cols + ((col + 1) % cols);
      } else if (event.key === "ArrowLeft") {
        next = row * cols + ((col + cols - 1) % cols);
      } else if (event.key === "ArrowDown") {
        next = ((row + 1) % rows) * cols + col;
      } else if (event.key === "ArrowUp") {
        next = ((row + rows - 1) % rows) * cols + col;
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const cell = grid[focusIndex];
        if (cell) {
          selectCell(cell);
        }
        return;
      } else if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      } else {
        return;
      }
      event.preventDefault();
      setFocusIndex(next);
    },
    [focusIndex, grid, onClose, selectCell],
  );

  if (!open) {
    return null;
  }

  const chanceReady = currentNode?.kind === "chance" && options.length > 0;

  return (
    <div className="card-picker-overlay" role="presentation" onClick={onClose}>
      <div
        className="card-picker"
        role="dialog"
        aria-label="Next-card picker"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
        ref={(node) => node?.focus()}
      >
        <div className="panel-title-row">
          <h2 className="panel-title">Next card</h2>
          <button type="button" className="toolbar-btn" onClick={onClose}>
            Close
          </button>
        </div>
        {!chanceReady ? (
          <p className="empty-hint">
            Card picker is available on chance nodes with legal next cards from the engine.
          </p>
        ) : (
          <>
            <p className="hint">
              Conditional weights from the node — board blockers marked. Arrow keys move; Enter
              follows the line.
            </p>
            <div className="card-picker-grid" role="grid" aria-label="Rank and suit">
              <div className="card-picker-corner" />
              {CARD_SUITS.map((suit) => (
                <div key={suit} className="card-picker-suit muted">
                  {suit}
                </div>
              ))}
              {CARD_RANKS.map((rank, rowIndex) => (
                <div key={rank} className="card-picker-rank-row" role="row">
                  <div className="card-picker-rank muted">{rank}</div>
                  {CARD_SUITS.map((suit, colIndex) => {
                    const index = rowIndex * CARD_SUITS.length + colIndex;
                    const cell = grid[index]!;
                    const legal = !isMissing(cell) && !cell.blocked;
                    const focused = index === focusIndex;
                    return (
                      <button
                        key={cell.card}
                        type="button"
                        role="gridcell"
                        className="card-picker-cell"
                        data-suit={suit}
                        data-blocked={cell.blocked ? "true" : "false"}
                        data-missing={isMissing(cell) ? "true" : "false"}
                        data-focused={focused ? "true" : "false"}
                        disabled={!legal}
                        aria-label={`${cell.card}${
                          !isMissing(cell) && cell.weight != null
                            ? ` weight ${cell.weight.toFixed(4)}`
                            : cell.blocked
                              ? " board blocker"
                              : " unavailable"
                        }`}
                        onClick={() => selectCell(cell)}
                        onFocus={() => setFocusIndex(index)}
                      >
                        <span>{cell.card}</span>
                        {!isMissing(cell) && cell.weight != null ? (
                          <span className="card-picker-weight tabular">
                            {(cell.weight * 100).toFixed(1)}%
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
