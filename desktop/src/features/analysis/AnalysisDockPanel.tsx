import { useMemo, useState } from "react";
import {
  buildEquityChartCurve,
  categorySeatView,
  filterHandsByEquityBands,
  filteredEquityComposition,
  normalizeBucketWeights,
  type EquityChartPoint,
  type EquityHandRow,
} from "../../domain/analysis";
import { draftFromStudyNode } from "../../domain/equity/transfer";
import { useEquityStore } from "../../state/equityStore";
import { useStudyStore } from "../../state/studyStore";

interface CategoryPayload {
  available?: boolean;
  reason?: string;
  model?: string;
  exclusive?: boolean;
  categories?: string[];
  oop?: {
    fractions?: number[] | Record<string, number>;
    mass?: number[];
    defined?: boolean;
    total_mass?: number | null;
  };
  ip?: {
    fractions?: number[] | Record<string, number>;
    mass?: number[];
    defined?: boolean;
    total_mass?: number | null;
  };
  pending?: boolean;
}

interface EquityPayload {
  oop_equity?: number | null;
  ip_equity?: number | null;
  units?: string;
  model?: string;
  pending?: boolean;
  equity_distribution?: Array<{ lo: number; hi: number; weight: number }>;
  ip_equity_distribution?: Array<{ lo: number; hi: number; weight: number }>;
  oop_hands?: EquityHandRow[];
  ip_hands?: EquityHandRow[];
}

function EquityHistogram({
  title,
  buckets,
  selected,
  onToggle,
}: {
  title: string;
  buckets: Array<{ lo: number; hi: number; weight: number }> | undefined;
  selected: Set<string>;
  onToggle: (lo: number, hi: number) => void;
}) {
  const rows = useMemo(() => normalizeBucketWeights(buckets), [buckets]);
  if (!rows.length) {
    return <p className="empty-hint">No distribution.</p>;
  }
  return (
    <div className="equity-hist">
      <h3 className="panel-subtitle">{title}</h3>
      <div className="equity-bars" role="list" aria-label={`${title} equity histogram`}>
        {rows.map((bucket) => {
          const key = `${bucket.lo}:${bucket.hi}`;
          const active = selected.has(key);
          return (
            <button
              key={key}
              type="button"
              className="equity-bar-row equity-bar-row--button"
              role="listitem"
              data-active={active ? "true" : "false"}
              aria-pressed={active}
              title="Toggle equity band filter"
              onClick={() => onToggle(bucket.lo, bucket.hi)}
            >
              <span className="tabular muted">
                {bucket.lo.toFixed(1)}–{bucket.hi.toFixed(1)}
              </span>
              <span className="equity-bar-track">
                <span
                  className="equity-bar"
                  style={{ width: `${Math.min(100, bucket.fraction * 100)}%` }}
                />
              </span>
              <span className="tabular">{(bucket.fraction * 100).toFixed(1)}%</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function stepPath(
  points: EquityChartPoint[],
  toX: (percentile: number) => number,
  toY: (equity: number) => number,
): string {
  if (!points.length) {
    return "";
  }
  let d = `M ${toX(points[0]!.percentile)} ${toY(points[0]!.equity)}`;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    // Horizontal then vertical step (stair plot).
    d += ` L ${toX(cur.percentile)} ${toY(prev.equity)} L ${toX(cur.percentile)} ${toY(cur.equity)}`;
  }
  return d;
}

/** GTO Wizard–style OOP vs IP equity distribution chart. */
function EquityDistributionChart({
  oopPoints,
  ipPoints,
}: {
  oopPoints: EquityChartPoint[];
  ipPoints: EquityChartPoint[];
}) {
  const width = 360;
  const height = 220;
  const pad = { top: 12, right: 12, bottom: 28, left: 36 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const toX = (percentile: number) => pad.left + (percentile / 100) * innerW;
  const toY = (equity: number) => pad.top + (1 - equity) * innerH;
  const ticks = [0, 25, 50, 75, 100];
  const oopPath = stepPath(oopPoints, toX, toY);
  const ipPath = stepPath(ipPoints, toX, toY);
  const empty = !oopPath && !ipPath;

  return (
    <div className="equity-chart">
      <h3 className="panel-subtitle">Equity chart</h3>
      <div className="equity-chart-legend" aria-hidden="true">
        <span className="equity-chart-legend__item">
          <span className="equity-chart-swatch equity-chart-swatch--ip" />
          IP
        </span>
        <span className="equity-chart-legend__item">
          <span className="equity-chart-swatch equity-chart-swatch--oop" />
          OOP
        </span>
      </div>
      {empty ? (
        <p className="empty-hint">No equity hands.</p>
      ) : (
        <svg
          className="equity-chart-svg"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="OOP versus IP equity distribution chart"
        >
          {ticks.map((tick) => (
            <g key={`grid-${tick}`}>
              <line
                className="equity-chart-grid"
                x1={pad.left}
                y1={toY(tick / 100)}
                x2={width - pad.right}
                y2={toY(tick / 100)}
              />
              <text
                className="equity-chart-label"
                x={pad.left - 6}
                y={toY(tick / 100)}
                textAnchor="end"
                dominantBaseline="middle"
              >
                {tick === 100 ? "00" : tick === 0 ? "0" : String(tick)}
              </text>
              <text
                className="equity-chart-label"
                x={toX(tick)}
                y={height - 8}
                textAnchor="middle"
              >
                {tick === 0 ? "" : String(tick)}
              </text>
            </g>
          ))}
          {oopPath ? (
            <path className="equity-chart-line equity-chart-line--oop" d={oopPath} fill="none" />
          ) : null}
          {ipPath ? (
            <path className="equity-chart-line equity-chart-line--ip" d={ipPath} fill="none" />
          ) : null}
        </svg>
      )}
    </div>
  );
}

function bandKey(lo: number, hi: number): string {
  return `${lo}:${hi}`;
}

/** Equity and Categories panels for the Study lower dock. */
export function AnalysisDockPanel() {
  const categories = useStudyStore((s) => s.categories) as CategoryPayload | null;
  const equity = useStudyStore((s) => s.equity) as EquityPayload | null;
  const loadCategories = useStudyStore((s) => s.loadCategories);
  const loadEquity = useStudyStore((s) => s.loadEquity);
  const analysisTab = useStudyStore((s) => s.analysisTab);
  const currentNode = useStudyStore((s) => s.currentNode);
  const solutionId = useStudyStore((s) => s.solutionId);
  const setWorkspace = useStudyStore((s) => s.setWorkspace);
  const [categorySeat, setCategorySeat] = useState<"oop" | "ip">("oop");
  const [equitySeat, setEquitySeat] = useState<"oop" | "ip">("oop");
  const [selectedBands, setSelectedBands] = useState<Set<string>>(() => new Set());
  const [transferMessage, setTransferMessage] = useState<string | null>(null);

  const studyTransfer = useMemo(() => {
    if (!currentNode || !solutionId) {
      return { ok: false as const, reason: "No Study node selected." };
    }
    return draftFromStudyNode({ node: currentNode, solutionId });
  }, [currentNode, solutionId]);

  const categoryView = useMemo(
    () =>
      categorySeatView(
        categories?.categories,
        categorySeat === "oop" ? categories?.oop : categories?.ip,
      ),
    [categories, categorySeat],
  );

  const equityHands = equitySeat === "oop" ? equity?.oop_hands : equity?.ip_hands;
  const equityBuckets =
    equitySeat === "oop" ? equity?.equity_distribution : equity?.ip_equity_distribution;

  const filteredView = useMemo(() => {
    const bands = [...selectedBands].map((key) => {
      const [lo, hi] = key.split(":").map(Number);
      return { lo: lo ?? 0, hi: hi ?? 0 };
    });
    const hands = filterHandsByEquityBands(equityHands, bands.length ? bands : null);
    return filteredEquityComposition(hands);
  }, [equityHands, selectedBands]);

  const oopChartPoints = useMemo(
    () => buildEquityChartCurve(equity?.oop_hands),
    [equity?.oop_hands],
  );
  const ipChartPoints = useMemo(
    () => buildEquityChartCurve(equity?.ip_hands),
    [equity?.ip_hands],
  );

  const toggleBand = (lo: number, hi: number) => {
    const key = bandKey(lo, hi);
    setSelectedBands((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  if (analysisTab === "equity") {
    return (
      <div className="range-explorer">
        <div className="panel-title-row">
          <h2 className="panel-title">Equity</h2>
          <div className="panel-title-actions">
            <div className="seat-toggle" role="group" aria-label="Equity seat">
              <button
                type="button"
                className="toolbar-btn"
                aria-pressed={equitySeat === "oop"}
                onClick={() => setEquitySeat("oop")}
              >
                OOP
              </button>
              <button
                type="button"
                className="toolbar-btn"
                aria-pressed={equitySeat === "ip"}
                onClick={() => setEquitySeat("ip")}
              >
                IP
              </button>
            </div>
            <button type="button" className="toolbar-btn" onClick={() => void loadEquity()}>
              Refresh
            </button>
            <button
              type="button"
              className="toolbar-btn"
              disabled={!studyTransfer.ok}
              title={
                studyTransfer.ok
                  ? "Copy this node's reaching ranges into the Equity calculator"
                  : studyTransfer.reason
              }
              onClick={() => {
                if (!studyTransfer.ok) {
                  setTransferMessage(studyTransfer.reason);
                  return;
                }
                useEquityStore.getState().importDraft(studyTransfer.draft);
                setTransferMessage(null);
                setWorkspace("equity");
              }}
            >
              Open in Equity
            </button>
          </div>
        </div>
        <p className="equity-note muted">Equity (fraction of pot).</p>
        {transferMessage ? <p className="equity-note">{transferMessage}</p> : null}
        {!equity ? (
          <p className="empty-hint">Click Refresh to load equity.</p>
        ) : equity.pending ? (
          <p className="empty-hint">Loading…</p>
        ) : (
          <>
            <div className="inspector-meta">
              <div>
                <span className="muted">OOP avg</span>
                <strong className="tabular">
                  {equity.oop_equity == null ? "—" : equity.oop_equity.toFixed(4)}
                </strong>
              </div>
              <div>
                <span className="muted">IP avg</span>
                <strong className="tabular">
                  {equity.ip_equity == null ? "—" : equity.ip_equity.toFixed(4)}
                </strong>
              </div>
              <div>
                <span className="muted">Filter avg</span>
                <strong className="tabular">
                  {filteredView.averageEquity == null
                    ? "—"
                    : filteredView.averageEquity.toFixed(4)}
                </strong>
              </div>
            </div>
            <div className="equity-filter-row">
              <span className="muted">
                {selectedBands.size === 0
                  ? "All bands (click histogram to filter)"
                  : `${selectedBands.size} band${selectedBands.size === 1 ? "" : "s"} selected`}
              </span>
              {selectedBands.size > 0 ? (
                <button
                  type="button"
                  className="toolbar-btn"
                  onClick={() => setSelectedBands(new Set())}
                >
                  Clear filter
                </button>
              ) : null}
            </div>
            <div className="equity-hist-grid">
              <EquityHistogram
                title={`${equitySeat.toUpperCase()} distribution`}
                buckets={equityBuckets}
                selected={selectedBands}
                onToggle={toggleBand}
              />
              <EquityDistributionChart oopPoints={oopChartPoints} ipPoints={ipChartPoints} />
            </div>
          </>
        )}
      </div>
    );
  }

  const model = categories?.model ?? "made-hand";
  const exclusive = categories?.exclusive !== false;
  const title =
    model === "draws" ? "Draw / Backdoor Categories" : "Made-hand Categories";

  return (
    <div className="range-explorer">
      <div className="panel-title-row">
        <h2 className="panel-title">{title}</h2>
        <div className="panel-title-actions">
          <div className="seat-toggle" role="group" aria-label="Category seat">
            <button
              type="button"
              className="toolbar-btn"
              aria-pressed={categorySeat === "oop"}
              onClick={() => setCategorySeat("oop")}
            >
              OOP
            </button>
            <button
              type="button"
              className="toolbar-btn"
              aria-pressed={categorySeat === "ip"}
              onClick={() => setCategorySeat("ip")}
            >
              IP
            </button>
          </div>
          <button type="button" className="toolbar-btn" onClick={() => void loadCategories()}>
            Refresh
          </button>
        </div>
      </div>
      {!categories ? (
        <p className="empty-hint">Click Refresh to load categories.</p>
      ) : categories.pending ? (
        <p className="empty-hint">Loading…</p>
      ) : categories.available === false ? (
        <p className="empty-hint">{categories.reason || "Not available on this board."}</p>
      ) : (
        <>
          <p className="equity-note muted">
            {exclusive
              ? "Exclusive made-hand buckets. Fractions of positive reach mass."
              : "Multi-label draws/backdoors. A combo may count in more than one row."}
          </p>
          <table className="data-table">
            <thead>
              <tr>
                <th>Category</th>
                <th>Mass</th>
                <th>%</th>
              </tr>
            </thead>
            <tbody>
              {categoryView.rows.map((row) => (
                <tr key={row.name}>
                  <td>{row.name}</td>
                  <td className="tabular">
                    {row.mass == null ? "—" : row.mass.toFixed(3)}
                  </td>
                  <td className="tabular">
                    <span
                      className="category-bar"
                      style={{ width: `${Math.min(100, row.fraction * 100)}%` }}
                    />{" "}
                    {(row.fraction * 100).toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
