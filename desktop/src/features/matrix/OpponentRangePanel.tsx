import { useMemo } from "react";
import { groupHands } from "../../domain/browse";
import { pairName } from "../../domain/range";
import { RANKS, type NodePayload } from "../../domain/types";
import { useStudyStore } from "../../state/studyStore";

function rangeFill(weight: number): string {
  const t = Math.max(0, Math.min(1, weight));
  const r = Math.round(36 + (46 - 36) * t);
  const g = Math.round(92 + (148 - 92) * t);
  const b = Math.round(52 + (102 - 52) * t);
  return `rgb(${r}, ${g}, ${b})`;
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

/** Immutable solution snapshot for the non-acting seat (not Build draft weights). */
function opponentView(node: NodePayload | null): NodePayload | null {
  if (!node || node.opponent_player == null) {
    return null;
  }
  const combos = node.opponent_combos;
  if (!combos?.length) {
    return null;
  }
  const marginal =
    node.opponent_marginal ??
    node.opponent_reach ??
    combos.map(() => 0);
  return {
    node_id: node.node_id,
    kind: node.kind,
    player: node.opponent_player,
    reach_defined: node.reach_defined,
    combos,
    marginal,
    actions: [],
  };
}

export function OpponentRangePanel() {
  const currentNode = useStudyStore((s) => s.currentNode);
  const view = useMemo(() => opponentView(currentNode), [currentNode]);
  const cells = useMemo(() => (view ? groupHands(view) : []), [view]);
  const byKey = useMemo(() => {
    const map = new Map<string, (typeof cells)[number]>();
    for (const cell of cells) {
      map.set(`${cell.row}:${cell.col}`, cell);
    }
    return map;
  }, [cells]);
  const seat = seatLabel(view?.player ?? currentNode?.opponent_player);

  return (
    <section className="matrix-pane opponent-range-pane" aria-label={`${seat} range`}>
      <div className="panel-title-row">
        <h2 className="panel-title">{seat} range</h2>
      </div>
      {!view ? (
        <p className="empty-hint">Opponent reach appears on decision nodes.</p>
      ) : (
        <div className="range-matrix-wrap">
          <div className="range-matrix" role="grid" aria-label={`${seat} solution range`}>
            <div className="matrix-corner" />
            {RANKS.map((rank) => (
              <div key={`c-${rank}`} className="matrix-axis">
                {rank}
              </div>
            ))}
            {RANKS.map((rowRank, row) => (
              <div key={`r-${rowRank}`} className="matrix-row-fragment" style={{ display: "contents" }}>
                <div className="matrix-axis">{rowRank}</div>
                {RANKS.map((colRank, col) => {
                  const cell = byKey.get(`${row}:${col}`);
                  const label = cell?.text ?? pairName(row, col);
                  const empty = !cell || !cell.defined || cell.marginalSum <= 0;
                  const weight =
                    !empty && cell && cell.range_combos > 0
                      ? Math.min(1, cell.marginalSum / Math.max(1, cell.range_combos))
                      : 0;
                  return (
                    <div
                      key={`${rowRank}-${colRank}`}
                      className="matrix-cell"
                      role="gridcell"
                      data-empty={empty}
                      style={!empty ? { background: rangeFill(weight) } : undefined}
                      title={
                        empty
                          ? label
                          : `${label}: ${(weight * 100).toFixed(0)}%`
                      }
                    >
                      <span className="matrix-cell__label">{label}</span>
                      {!empty ? (
                        <span className="matrix-cell__sub">
                          {(weight * 100).toFixed(0)}
                        </span>
                      ) : null}
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
