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
  cycleRank,
  cycleSuit,
  dealStreetFromBoard,
  deckCellIndex,
  deckCoords,
  fullDeckGrid,
  isLegalDeckCell,
  isMissingDeckCell,
  suitSymbol,
  type DealStreet,
  type DeckCell,
} from "../../domain/cards";
import { useStudyStore } from "../../state/studyStore";
import { PlayingCard } from "../cards/PlayingCard";
import "../../styles/cards.css";

export interface CardPickerProps {
  open: boolean;
  onClose: () => void;
  /** Street whose next card is being chosen (defaults from current chance board). */
  street?: DealStreet | null;
}

function rankKeyToRank(key: string): string | null {
  const upper = key.length === 1 ? key.toUpperCase() : "";
  if (CARD_RANKS.includes(upper as (typeof CARD_RANKS)[number])) {
    return upper;
  }
  if (key === "10") {
    return "T";
  }
  return null;
}

function suitKeyToSuit(key: string): string | null {
  const lower = key.toLowerCase();
  if (CARD_SUITS.includes(lower as (typeof CARD_SUITS)[number])) {
    return lower;
  }
  return null;
}

export function CardPicker({ open, onClose, street = null }: CardPickerProps) {
  const currentNode = useStudyStore((s) => s.currentNode);
  const followAction = useStudyStore((s) => s.followAction);
  const [focusIndex, setFocusIndex] = useState(0);

  const options = useMemo(() => chanceCardOptions(currentNode), [currentNode]);
  const grid = useMemo(
    () => fullDeckGrid(options, currentNode?.board),
    [options, currentNode?.board],
  );
  const activeStreet =
    street ?? dealStreetFromBoard(currentNode?.board) ?? ("turn" as DealStreet);

  useEffect(() => {
    if (!open) {
      return;
    }
    const firstLegal = grid.findIndex((cell) => isLegalDeckCell(cell));
    setFocusIndex(firstLegal >= 0 ? firstLegal : 0);
  }, [open, grid]);

  const selectCell = useCallback(
    (cell: DeckCell) => {
      if (!isLegalDeckCell(cell)) {
        return;
      }
      void followAction(cell.nodeId);
      onClose();
    },
    [followAction, onClose],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      const cols = CARD_RANKS.length;
      const rows = CARD_SUITS.length;
      const { row, col, rank, suit } = deckCoords(focusIndex);
      let next = focusIndex;

      if (event.key === "ArrowRight") {
        next = row * cols + ((col + 1) % cols);
      } else if (event.key === "ArrowLeft") {
        next = row * cols + ((col + cols - 1) % cols);
      } else if (event.key === "ArrowDown") {
        next = ((row + 1) % rows) * cols + col;
      } else if (event.key === "ArrowUp") {
        next = ((row + rows - 1) % rows) * cols + col;
      } else if (event.key === "[" || event.key === "]") {
        // Pio-like suit cycle within the focused rank.
        const delta = event.key === "]" ? 1 : -1;
        const nextSuit = cycleSuit(suit, delta);
        const idx = deckCellIndex(rank, nextSuit);
        if (idx >= 0) {
          next = idx;
        }
      } else if (event.key === "," || event.key === ".") {
        // Pio-like rank cycle within the focused suit.
        const delta = event.key === "." ? 1 : -1;
        const nextRank = cycleRank(rank, delta);
        const idx = deckCellIndex(nextRank, suit);
        if (idx >= 0) {
          next = idx;
        }
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
        const asRank = rankKeyToRank(event.key);
        const asSuit = suitKeyToSuit(event.key);
        if (asRank) {
          const idx = deckCellIndex(asRank, suit);
          if (idx >= 0) {
            next = idx;
          }
        } else if (asSuit) {
          const idx = deckCellIndex(rank, asSuit);
          if (idx >= 0) {
            next = idx;
          }
        } else {
          return;
        }
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
        aria-label={`${activeStreet} card picker`}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
        ref={(node) => node?.focus()}
      >
        <div className="panel-title-row">
          <h2 className="panel-title">
            {activeStreet === "river" ? "River card" : "Turn card"}
          </h2>
          <button type="button" className="toolbar-btn" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="card-picker__street" aria-live="polite">
          <span className="card-picker__street-pill">{activeStreet}</span>
          <span className="muted">Changing this street’s next card</span>
        </div>
        {!chanceReady ? (
          <p className="empty-hint">No next cards at this node.</p>
        ) : (
          <>
            <p className="card-picker__hint">
              Arrows move · rank/suit keys jump · [ ] cycle suit · , . cycle rank ·
              Enter selects · Esc closes. Unavailable cards stay in place, faded.
            </p>
            <div
              className="card-picker-grid"
              role="grid"
              aria-label="Suit and rank"
            >
              <div className="card-picker-header" role="row">
                <div className="card-picker-corner" />
                {CARD_RANKS.map((rank) => (
                  <div key={rank} className="card-picker-rank muted">
                    {rank}
                  </div>
                ))}
              </div>
              {CARD_SUITS.map((suit, rowIndex) => (
                <div
                  key={suit}
                  className="card-picker-suit-row"
                  role="row"
                  data-suit={suit}
                >
                  <div
                    className="card-picker-suit-label"
                    data-suit={suit}
                    aria-label={suit}
                  >
                    {suitSymbol(suit)}
                  </div>
                  {CARD_RANKS.map((_, colIndex) => {
                    const index = rowIndex * CARD_RANKS.length + colIndex;
                    const cell = grid[index]!;
                    const legal = isLegalDeckCell(cell);
                    const focused = index === focusIndex;
                    return (
                      <button
                        key={cell.card}
                        type="button"
                        role="gridcell"
                        className="card-picker-cell"
                        data-suit={suit}
                        data-blocked={cell.blocked ? "true" : "false"}
                        data-missing={isMissingDeckCell(cell) ? "true" : "false"}
                        data-focused={focused ? "true" : "false"}
                        disabled={!legal}
                        aria-label={`${cell.card}${
                          cell.blocked
                            ? " board blocker"
                            : isMissingDeckCell(cell)
                              ? " unavailable"
                              : ""
                        }`}
                        onClick={() => selectCell(cell)}
                        onFocus={() => setFocusIndex(index)}
                      >
                        <PlayingCard
                          card={cell.card}
                          size="md"
                          faded={!legal}
                          focused={focused}
                          selected={focused}
                          aria-hidden
                        />
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
