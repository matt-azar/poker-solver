import { useMemo, useRef } from "react";
import { isHandLocked, lockForNode } from "../../domain/locks";
import { comboKey } from "../../domain/matrixDisplay";
import { combosForCell, pairName } from "../../domain/range";
import { RANKS } from "../../domain/types";
import { useStudyStore } from "../../state/studyStore";

type PaintMode = "add" | "remove";

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

/**
 * Mini 13×13 range-paint matrix for selecting hand classes into the lock draft.
 * Paint strokes add or remove every node combo in a class (Pio / GTOW style).
 */
export function LockPaintPanel() {
  const currentNode = useStudyStore((s) => s.currentNode);
  const locks = useStudyStore((s) => s.locks);
  const lockDraft = useStudyStore((s) => s.lockDraft);
  const toggleLockHand = useStudyStore((s) => s.toggleLockHand);
  const gridRef = useRef<HTMLDivElement>(null);
  const paintingRef = useRef(false);
  const modeRef = useRef<PaintMode>("add");
  const visitedRef = useRef<Set<string>>(new Set());
  const paintedByPointerRef = useRef(false);

  const nodeLock = useMemo(
    () => (currentNode ? lockForNode(locks, currentNode.node_id) : null),
    [locks, currentNode],
  );

  const selectedSet = useMemo(
    () => new Set(lockDraft.handIndices),
    [lockDraft.handIndices],
  );

  const cellMeta = useMemo(() => {
    const combos = currentNode?.combos ?? [];
    const meta: Array<
      Array<{
        label: string;
        indices: number[];
        selected: boolean;
        locked: boolean;
        available: boolean;
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
        rowMeta.push({
          label: pairName(row, col),
          indices,
          selected,
          locked,
          available: indices.length > 0,
        });
      }
      meta.push(rowMeta);
    }
    return meta;
  }, [currentNode?.combos, selectedSet, nodeLock]);

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
          Full-node lock selects every combo. Switch to Selected combos to paint
          hand classes.
        </p>
      </div>
    );
  }

  return (
    <div className="lock-paint-panel">
      <p className="lock-paint-panel__hint">
        Paint hand classes to include their node combos in the lock. Click a
        selected class again to remove it.
      </p>
      <div
        ref={gridRef}
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
          if (!paintingRef.current) {
            return;
          }
          const cell = cellFromEventTarget(
            document.elementFromPoint(event.clientX, event.clientY),
          );
          if (!cell) {
            return;
          }
          applyCell(cell.row, cell.col, modeRef.current);
        }}
        onPointerUp={finishStroke}
        onPointerCancel={finishStroke}
        onLostPointerCapture={finishStroke}
      >
        {RANKS.map((_, row) =>
          RANKS.map((_, col) => {
            const meta = cellMeta[row]![col]!;
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
                title={meta.label}
                aria-label={`${meta.label}${meta.selected ? " selected" : ""}${meta.locked ? " locked" : ""}`}
                disabled={!meta.available}
                onClick={() => {
                  // Pointer strokes already applied on pointerdown; skip the
                  // synthesized mouse click. Keyboard activation still runs.
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
                {meta.label}
              </button>
            );
          }),
        )}
      </div>
    </div>
  );
}
