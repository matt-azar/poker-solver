import { useMemo, useRef, useState } from "react";
import { mapActionColors } from "../../domain/actionColors";
import { orderActionIndicesByAggression } from "../../domain/actionOrder";
import {
  isHandLocked,
  lockForNode,
  weightedStrategyMix,
} from "../../domain/locks";
import { comboKey } from "../../domain/matrixDisplay";
import { combosForCell, pairName } from "../../domain/range";
import { RANKS } from "../../domain/types";
import { useStudyStore } from "../../state/studyStore";

type PaintMode = "add" | "remove";

export type LockHighlightFilter = "all" | "selected" | "locked" | "unlocked";

function cellFromEventTarget(
  target: EventTarget | null,
): { row: number; col: number } | null {
  if (!(target instanceof Element)) {
    return null;
  }
  const button = target.closest<HTMLElement>(".lock-paint-cell");
  if (!button) {
    return null;
  }
  const row = Number(button.dataset.row);
  const col = Number(button.dataset.col);
  if (!Number.isInteger(row) || !Number.isInteger(col)) {
    return null;
  }
  return { row, col };
}

/** Indices of node combos that belong to the 169-cell at (row, col). */
export function nodeIndicesForCell(
  nodeCombos: string[] | undefined,
  row: number,
  col: number,
): number[] {
  if (!nodeCombos?.length) {
    return [];
  }
  const keys = new Set(combosForCell(row, col).map((combo) => comboKey(combo)));
  const indices: number[] = [];
  nodeCombos.forEach((combo, index) => {
    if (keys.has(comboKey(combo))) {
      indices.push(index);
    }
  });
  return indices;
}

export interface LockPaintPanelProps {
  /** Which cells stay visually emphasized (Pio presentation filter). */
  highlight?: LockHighlightFilter;
  /** Report the hovered hand class for the detail rail. */
  onFocusChange?: (focus: { row: number; col: number; text: string } | null) => void;
}

/**
 * Pio-style 13×13 range-paint matrix for selecting hand classes into the lock draft.
 * Cells show current strategy mix; paint strokes add/remove every node combo in a class.
 */
export function LockPaintPanel({
  highlight = "all",
  onFocusChange,
}: LockPaintPanelProps) {
  const currentNode = useStudyStore((s) => s.currentNode);
  const locks = useStudyStore((s) => s.locks);
  const lockDraft = useStudyStore((s) => s.lockDraft);
  const toggleLockHand = useStudyStore((s) => s.toggleLockHand);
  const paintingRef = useRef(false);
  const modeRef = useRef<PaintMode>("add");
  const visitedRef = useRef<Set<string>>(new Set());
  const paintedByPointerRef = useRef(false);
  const [hoverKey, setHoverKey] = useState<string | null>(null);

  const nodeLock = useMemo(
    () => (currentNode ? lockForNode(locks, currentNode.node_id) : null),
    [locks, currentNode],
  );

  const selectedSet = useMemo(
    () => new Set(lockDraft.handIndices),
    [lockDraft.handIndices],
  );

  const colors = useMemo(
    () => mapActionColors(currentNode?.actions ?? []),
    [currentNode?.actions],
  );

  const cellMeta = useMemo(() => {
    const combos = currentNode?.combos ?? [];
    const strategy = currentNode?.strategy ?? null;
    const marginal = Array.isArray(currentNode?.marginal)
      ? (currentNode.marginal as number[])
      : null;
    const actionCount = currentNode?.actions?.length ?? 0;
    const meta: Array<
      Array<{
        label: string;
        indices: number[];
        selected: boolean;
        locked: boolean;
        available: boolean;
        segments: Array<{ color: string; weight: number }>;
      }>
    > = [];
    for (let row = 0; row < 13; row++) {
      const rowMeta = [];
      for (let col = 0; col < 13; col++) {
        const indices = nodeIndicesForCell(combos, row, col);
        const selected =
          indices.length > 0 && indices.every((index) => selectedSet.has(index));
        const locked =
          indices.length > 0 && indices.every((index) => isHandLocked(nodeLock, index));
        const mix = weightedStrategyMix(strategy, indices, actionCount, marginal);
        const actionLabels = currentNode?.actions ?? [];
        const order = orderActionIndicesByAggression(actionLabels);
        const segments =
          mix == null
            ? []
            : order.map((actionIndex) => ({
                weight: mix[actionIndex] ?? 0,
                color: colors.byIndex[actionIndex] || "#666",
              }));
        rowMeta.push({
          label: pairName(row, col),
          indices,
          selected,
          locked,
          available: indices.length > 0,
          segments,
        });
      }
      meta.push(rowMeta);
    }
    return meta;
  }, [
    currentNode?.combos,
    currentNode?.strategy,
    currentNode?.marginal,
    currentNode?.actions,
    selectedSet,
    nodeLock,
    colors.byIndex,
  ]);

  const applyCell = (row: number, col: number, mode: PaintMode) => {
    const key = `${row}:${col}`;
    if (visitedRef.current.has(key)) {
      return;
    }
    visitedRef.current.add(key);
    const indices = nodeIndicesForCell(currentNode?.combos, row, col);
    if (indices.length === 0) {
      return;
    }
    for (const index of indices) {
      const selected = useStudyStore.getState().lockDraft.handIndices.includes(index);
      if (mode === "add" && !selected) {
        toggleLockHand(index);
      } else if (mode === "remove" && selected) {
        toggleLockHand(index);
      }
    }
  };

  const finishStroke = () => {
    if (!paintingRef.current) {
      return;
    }
    paintingRef.current = false;
    visitedRef.current.clear();
  };

  const reportFocus = (row: number, col: number) => {
    const key = `${row}:${col}`;
    setHoverKey(key);
    onFocusChange?.({ row, col, text: pairName(row, col) });
  };

  if (!currentNode) {
    return (
      <div className="lock-paint-panel">
        <p className="empty-hint">Load a decision node to paint locks.</p>
      </div>
    );
  }

  if (lockDraft.kind === "full") {
    return (
      <div className="lock-paint-panel">
        <p className="lock-paint-panel__hint">
          Full-node lock constrains every combo. Switch to Selected combos to paint
          hand classes.
        </p>
      </div>
    );
  }

  return (
    <div className="lock-paint-panel">
      <p className="lock-paint-panel__hint">
        Paint hand classes to include their combos. Drag to add or remove. Cells show
        the current strategy mix; green outline marks already-locked hands.
      </p>
      <div
        className="lock-paint-grid"
        role="grid"
        aria-label="Paint lock hand classes"
        onPointerDown={(event) => {
          if (event.button !== 0) {
            return;
          }
          const cell = cellFromEventTarget(event.target);
          if (!cell) {
            return;
          }
          const meta = cellMeta[cell.row]?.[cell.col];
          if (!meta?.available) {
            return;
          }
          event.preventDefault();
          paintingRef.current = true;
          paintedByPointerRef.current = true;
          visitedRef.current.clear();
          modeRef.current = meta.selected ? "remove" : "add";
          applyCell(cell.row, cell.col, modeRef.current);
          if (typeof event.currentTarget.setPointerCapture === "function") {
            event.currentTarget.setPointerCapture(event.pointerId);
          }
        }}
        onPointerMove={(event) => {
          // jsdom lacks elementFromPoint; fall back to the event target.
          const hit =
            typeof document.elementFromPoint === "function"
              ? document.elementFromPoint(event.clientX, event.clientY)
              : event.target;
          const under = cellFromEventTarget(hit);
          if (under) {
            reportFocus(under.row, under.col);
          }
          if (!paintingRef.current || !under) {
            return;
          }
          applyCell(under.row, under.col, modeRef.current);
        }}
        onPointerUp={finishStroke}
        onPointerCancel={finishStroke}
        onLostPointerCapture={finishStroke}
        onPointerLeave={() => {
          setHoverKey(null);
          onFocusChange?.(null);
        }}
      >
        {RANKS.map((_, row) =>
          RANKS.map((_, col) => {
            const meta = cellMeta[row]![col]!;
            const dimmed =
              highlight === "selected"
                ? !meta.selected
                : highlight === "locked"
                  ? !meta.locked
                  : highlight === "unlocked"
                    ? meta.locked || !meta.available
                    : false;
            const hovered = hoverKey === `${row}:${col}`;
            return (
              <button
                key={`lock-paint-${row}-${col}`}
                type="button"
                className="lock-paint-cell"
                data-row={row}
                data-col={col}
                data-available={meta.available ? "true" : "false"}
                data-selected={meta.selected ? "true" : "false"}
                data-locked={meta.locked ? "true" : "false"}
                data-dimmed={dimmed ? "true" : "false"}
                data-hover={hovered ? "true" : "false"}
                title={meta.label}
                aria-label={`${meta.label}${meta.selected ? " selected" : ""}${meta.locked ? " locked" : ""}`}
                disabled={!meta.available}
                onMouseEnter={() => reportFocus(row, col)}
                onFocus={() => reportFocus(row, col)}
                onClick={() => {
                  if (paintedByPointerRef.current) {
                    paintedByPointerRef.current = false;
                    return;
                  }
                  modeRef.current = meta.selected ? "remove" : "add";
                  visitedRef.current.clear();
                  applyCell(row, col, modeRef.current);
                  visitedRef.current.clear();
                }}
              >
                {meta.segments.length > 0 ? (
                  <span className="lock-paint-cell__segments" aria-hidden>
                    {meta.segments.map((seg, index) =>
                      seg.weight > 0.001 ? (
                        <span
                          key={index}
                          className="lock-paint-cell__seg"
                          style={{
                            flexGrow: seg.weight,
                            flexBasis: 0,
                            background: seg.color,
                          }}
                        />
                      ) : null,
                    )}
                  </span>
                ) : null}
                <span className="lock-paint-cell__label">{meta.label}</span>
              </button>
            );
          }),
        )}
      </div>
    </div>
  );
}
