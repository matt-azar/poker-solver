import { useEffect, useMemo, useState } from "react";
import type { EquityHandRow } from "../../domain/analysis";
import { formatFrequencyPct } from "../../domain/betSizes";
import { formatEquityPct, equityHandsForNode } from "../../domain/matrixDisplay";
import {
  DEFAULT_BLUFF_EQUITY_THRESHOLD,
  MIN_BET_FREQ,
  listProminentBluffs,
  matrixCellForCombo,
  type BluffEquityMode,
} from "../../domain/prominentBluffs";
import { useStudyStore } from "../../state/studyStore";

const DISPLAY_CAP = 50;

interface EquityPayload {
  pending?: boolean;
  oop_hands?: EquityHandRow[];
  ip_hands?: EquityHandRow[];
  node_id?: string;
}

function clampThreshold(raw: number): number {
  if (!Number.isFinite(raw)) {
    return DEFAULT_BLUFF_EQUITY_THRESHOLD;
  }
  return Math.min(1, Math.max(0, raw));
}

/** Study lower-dock Bluffs tab — Mode A (current-node check-down equity). */
export function BluffsPanel() {
  const currentNode = useStudyStore((s) => s.currentNode);
  const equity = useStudyStore((s) => s.equity) as EquityPayload | null;
  const loadEquity = useStudyStore((s) => s.loadEquity);
  const setSelectedCell = useStudyStore((s) => s.setSelectedCell);
  const solutionId = useStudyStore((s) => s.solutionId);

  const [thresholdPct, setThresholdPct] = useState(
    () => Math.round(DEFAULT_BLUFF_EQUITY_THRESHOLD * 100),
  );
  const [equityMode, setEquityMode] = useState<BluffEquityMode>("node");

  const threshold = clampThreshold(thresholdPct / 100);
  const equityPending = Boolean(equity?.pending);
  const equityReady = Boolean(equity && !equity.pending);

  useEffect(() => {
    if (!solutionId || !currentNode) {
      return;
    }
    if (equityReady || equityPending) {
      return;
    }
    void loadEquity();
  }, [solutionId, currentNode, equityReady, equityPending, loadEquity]);

  const equityHands = useMemo(
    () => equityHandsForNode(equity, currentNode?.player) as EquityHandRow[] | null,
    [equity, currentNode?.player],
  );

  const rows = useMemo(() => {
    if (equityMode !== "node") {
      return [];
    }
    return listProminentBluffs({
      node: currentNode,
      equityHands,
      threshold,
      equityMode: "node",
      minBetFreq: MIN_BET_FREQ,
    });
  }, [currentNode, equityHands, threshold, equityMode]);

  const visible = rows.slice(0, DISPLAY_CAP);
  const thresholdLabel = `${Math.round(threshold * 100)}%`;

  const onRowActivate = (combo: string) => {
    const cell = matrixCellForCombo(combo);
    if (!cell) {
      return;
    }
    setSelectedCell(cell);
  };

  return (
    <div className="range-explorer">
      <div className="panel-title-row">
        <h2 className="panel-title">Prominent bluffs</h2>
        <div className="panel-title-actions">
          <button
            type="button"
            className="toolbar-btn"
            disabled={!solutionId || !currentNode}
            onClick={() => void loadEquity()}
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="bluffs-controls">
        <label className="bluffs-control">
          <span className="muted">Equity &lt;</span>
          <input
            type="number"
            className="bluffs-threshold"
            min={0}
            max={100}
            step={1}
            value={thresholdPct}
            aria-label="Equity threshold percent"
            onChange={(event) => {
              const next = Number(event.target.value);
              if (!Number.isFinite(next)) {
                return;
              }
              setThresholdPct(Math.min(100, Math.max(0, Math.round(next))));
            }}
          />
          <span className="muted">%</span>
        </label>
        <div className="seat-toggle" role="group" aria-label="Bluff equity mode">
          <button
            type="button"
            className="toolbar-btn"
            aria-pressed={equityMode === "node"}
            onClick={() => setEquityMode("node")}
          >
            At this node
          </button>
          <button
            type="button"
            className="toolbar-btn"
            aria-pressed={equityMode === "after_call"}
            disabled
            title="Post-call equity uses /equity on the Call child (coming next)."
            onClick={() => setEquityMode("after_call")}
          >
            After call
          </button>
        </div>
      </div>

      <p className="equity-note muted">
        Check-down equity &lt; {thresholdLabel}; bet/raise/all-in ≥ 1%; sorted by
        bet frequency. After-call mode ships in a follow-up.
      </p>

      {!currentNode ? (
        <p className="empty-hint">Browse a decision node after a solve.</p>
      ) : currentNode.kind === "chance" || currentNode.kind === "terminal" ? (
        <p className="empty-hint">Bluffs need a decision node (bet or raise).</p>
      ) : !equity ? (
        <p className="empty-hint">Click Refresh to load equity.</p>
      ) : equity.pending ? (
        <p className="empty-hint">Loading…</p>
      ) : equityMode === "after_call" ? (
        <p className="empty-hint">
          After-call equity is not wired yet. Stay on “At this node” for Mode A.
        </p>
      ) : !visible.length ? (
        <p className="empty-hint">
          No bluffs with bet ≥ 1% and equity &lt; {thresholdLabel} (at this node).
        </p>
      ) : (
        <>
          {rows.length > DISPLAY_CAP ? (
            <p className="equity-note muted">
              Showing {DISPLAY_CAP} of {rows.length}
            </p>
          ) : null}
          <table className="data-table">
            <thead>
              <tr>
                <th>Hand</th>
                <th>Bet %</th>
                <th>Eq</th>
                <th>Size</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr
                  key={row.combo}
                  className="bluffs-row"
                  tabIndex={0}
                  role="button"
                  aria-label={`Select ${row.combo} on the matrix`}
                  onClick={() => onRowActivate(row.combo)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onRowActivate(row.combo);
                    }
                  }}
                >
                  <td>{row.combo}</td>
                  <td className="tabular">{formatFrequencyPct(row.betFreq) ?? "—"}</td>
                  <td className="tabular">{formatEquityPct(row.equity)}</td>
                  <td>{row.topBetAction ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
