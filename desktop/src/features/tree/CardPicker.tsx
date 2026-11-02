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
  /**
   * `overlay` — modal dialog (board slot click).
   * `inline` — embedded in the Study path “Cards” row (no dimmed backdrop).
   */
  variant?: "overlay" | "inline";
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

export function CardPicker({
  open,
  onClose,
  street = null,
  variant = "overlay",
}: CardPickerProps) {
  const currentNode = useStudyStore((s) => s.currentNode);
  const followAction = useStudyStore((s) => s.followAction);
  const [focusIndex, setFocusIndex] = useState(0);
  const [selectedCard, setSelectedCard] = useState<string | null>(null);

  const options = useMemo(() => chanceCardOptions(currentNode), [currentNode]);
  const grid = useMemo(
    () => fullDeckGrid(options, currentNode?.board),
    [options, currentNode?.board],
  );
  const activeStreet =
    street ?? dealStreetFromBoard(currentNode?.board) ?? ("turn" as DealStreet);
  const title =
    activeStreet === "river" ? "Change river" : "Change turn";

  useEffect(() => {
    if (!open) {
      setSelectedCard(null);
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
      setSelectedCard(cell.card);
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
        const delta = event.key === "]" ? 1 : -1;
        const nextSuit = cycleSuit(suit, delta);
        const idx = deckCellIndex(rank, nextSuit);
        if (idx >= 0) {
          next = idx;
        }
      } else if (event.key === "," || event.key === ".") {
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

  const panel = (
    <div
      className="card-picker"
      data-variant={variant}
      role={variant === "overlay" ? "dialog" : "region"}
      aria-label={`${activeStreet} card picker`}
      tabIndex={-1}
      onClick={variant === "overlay" ? (event) => event.stopPropagation() : undefined}
      onKeyDown={onKeyDown}
      ref={(node) => {
        if (variant === "overlay") {
          node?.focus();
        }
      }}
    >
      <div className="card-picker__head">
        <h2 className="card-picker__title">{title}</h2>
        {variant === "overlay" ? (
          <button type="button" className="toolbar-btn card-picker__close" onClick={onClose}>
            Close
          </button>
        ) : null}
      </div>
      {!chanceReady ? (
        <p className="empty-hint">No next cards at this node.</p>
      ) : (
        <div className="card-picker-grid" role="grid" aria-label="Suit and rank">
          {CARD_SUITS.map((suit, rowIndex) => (
            <div
              key={suit}
              className="card-picker-suit-row"
              role="row"
              data-suit={suit}
            >
              {CARD_RANKS.map((_, colIndex) => {
                const index = rowIndex * CARD_RANKS.length + colIndex;
                const cell = grid[index]!;
                const legal = isLegalDeckCell(cell);
                const focused = index === focusIndex;
                const selected = selectedCard === cell.card || focused;
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
                      layout="inline"
                      faded={!legal}
                      focused={focused}
                      selected={selected}
                      aria-hidden
                    />
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  if (variant === "inline") {
    return panel;
  }

  return (
    <div className="card-picker-overlay" role="presentation" onClick={onClose}>
      {panel}
    </div>
  );
}
