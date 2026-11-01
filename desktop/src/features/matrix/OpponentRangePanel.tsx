import { pairName } from "../../domain/range";
import { RANKS } from "../../domain/types";
import { useStudyStore } from "../../state/studyStore";

export function OpponentRangePanel() {
  const currentNode = useStudyStore((s) => s.currentNode);
  const weights = useStudyStore((s) => s.weights);
  const actingIsOop = currentNode?.player === 0 || currentNode?.to_act === "OOP";
  const seat = actingIsOop ? "ip" : "oop";
  const grid = weights[seat];

  return (
    <section className="matrix-pane opponent-range-pane" aria-label={`${seat.toUpperCase()} range`}>
      <div className="panel-title-row">
        <h2 className="panel-title">{seat.toUpperCase()} range</h2>
      </div>
      <div className="range-paint-grid" role="grid">
        {RANKS.map((rowRank, row) =>
          RANKS.map((colRank, col) => {
            const weight = grid[row][col];
            const label = pairName(row, col);
            return (
              <div
                key={`${seat}-${rowRank}-${colRank}`}
                className="paint-cell"
                data-on={weight > 0}
                style={
                  weight > 0
                    ? {
                        background: `rgba(63, 143, 107, ${0.25 + 0.75 * Math.min(weight, 1)})`,
                      }
                    : undefined
                }
                title={`${label}: ${weight}`}
              >
                {label}
              </div>
            );
          }),
        )}
      </div>
    </section>
  );
}
