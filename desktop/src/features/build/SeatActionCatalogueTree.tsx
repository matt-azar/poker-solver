import { useMemo } from "react";
import {
  getSeatActionCatalogue,
  loadBundledSeatActions,
} from "../../domain/profiles";
import {
  buildSeatActionTree,
  type SeatActionTreeNode,
} from "../../domain/profiles/seatActionTree";
import type { SeatActionRange } from "../../domain/profiles/seatActionTypes";

interface Props {
  onPick: (atom: SeatActionRange) => void;
}

function TreeNodes({
  nodes,
  onPick,
}: {
  nodes: SeatActionTreeNode[];
  onPick: (atom: SeatActionRange) => void;
}) {
  return (
    <ul className="seat-tree__list">
      {nodes.map((node) =>
        node.kind === "leaf" ? (
          <li key={node.id}>
            <button
              type="button"
              className="seat-tree__leaf"
              onClick={() => onPick(node.atom)}
            >
              {node.label}
            </button>
          </li>
        ) : (
          <li key={node.id}>
            <details className="seat-tree__branch">
              <summary>{node.label}</summary>
              <TreeNodes nodes={node.children} onPick={onPick} />
            </details>
          </li>
        ),
      )}
    </ul>
  );
}

/** Position → preflop-action range picker. Applies one seat's range. */
export function SeatActionCatalogueTree({ onPick }: Props) {
  const tree = useMemo(
    () => buildSeatActionTree(getSeatActionCatalogue(loadBundledSeatActions).list()),
    [],
  );

  if (!tree.length) {
    return <p className="empty-hint">No seat×action ranges are loaded.</p>;
  }

  return (
    <div className="seat-tree" role="tree" aria-label="Range catalogue">
      <TreeNodes nodes={tree} onPick={onPick} />
    </div>
  );
}
