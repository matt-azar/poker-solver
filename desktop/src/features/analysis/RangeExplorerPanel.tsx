import { useMemo, useState } from "react";
import {
  categorySeatView,
  filterHandsByEquityBands,
  filteredEquityComposition,
  normalizeBucketWeights,
  type EquityHandRow,
} from "../../domain/analysis";
import { mapActionColors } from "../../domain/actionColors";
import { groupHands, strategyMix } from "../../domain/browse";
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

function bandKey(lo: number, hi: number): string {
  return `${lo}:${hi}`;
}

export function RangeExplorerPanel() {
  const currentNode = useStudyStore((s) => s.currentNode);
  const categories = useStudyStore((s) => s.categories) as CategoryPayload | null;
  const equity = useStudyStore((s) => s.equity) as EquityPayload | null;
  const loadCategories = useStudyStore((s) => s.loadCategories);
  const loadEquity = useStudyStore((s) => s.loadEquity);
  const analysisTab = useStudyStore((s) => s.analysisTab);
  const setSelectedCell = useStudyStore((s) => s.setSelectedCell);
  const [categorySeat, setCategorySeat] = useState<"oop" | "ip">("oop");
  const [equitySeat, setEquitySeat] = useState<"oop" | "ip">("oop");
  const [selectedBands, setSelectedBands] = useState<Set<string>>(() => new Set());

  const colors = useMemo(
    () => mapActionColors(currentNode?.actions ?? []),
    [currentNode?.actions],
  );

  const topCells = useMemo(() => {
    if (!currentNode) {
      return [];
    }
    return groupHands(currentNode)
      .filter((cell) => cell.defined && cell.marginalSum > 0)
      .sort((a, b) => b.marginalSum - a.marginalSum)
      .slice(0, 24);
  }, [currentNode]);

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
          <h2 className="panel-title">Check-down equity</h2>
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
          </div>
        </div>
        <p className="equity-note muted">
          Check-down showdown equity (fraction of pot). Not chip EV.
        </p>
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
                <span className="muted">Filter mass</span>
                <strong className="tabular">{filteredView.totalWeight.toFixed(3)}</strong>
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
              <div className="equity-composition">
                <h3 className="panel-subtitle">Range composition</h3>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Shape</th>
                      <th>Mass</th>
                      <th>%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredView.shapes.map((row) => (
                      <tr key={row.name}>
                        <td>{row.name}</td>
                        <td className="tabular">{row.mass.toFixed(3)}</td>
                        <td className="tabular">{(row.fraction * 100).toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <h3 className="panel-subtitle">Top hands in filter</h3>
                {!filteredView.topHands.length ? (
                  <p className="empty-hint">No hands in the selected bands.</p>
                ) : (
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Hand</th>
                        <th>Eq</th>
                        <th>Wt</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredView.topHands.map((hand) => (
                        <tr key={hand.combo}>
                          <td>{hand.combo}</td>
                          <td className="tabular">{Number(hand.equity).toFixed(3)}</td>
                          <td className="tabular">{Number(hand.weight).toFixed(3)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  if (analysisTab === "explorer") {
    return (
      <div className="range-explorer">
        <div className="panel-title-row">
          <h2 className="panel-title">Range explorer</h2>
        </div>
        {!topCells.length ? (
          <p className="empty-hint">No range at this node.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Hand</th>
                <th>Mass</th>
                <th>Mix</th>
              </tr>
            </thead>
            <tbody>
              {topCells.map((cell) => {
                const mix = strategyMix(cell);
                return (
                  <tr
                    key={cell.text}
                    style={{ cursor: "pointer" }}
                    onClick={() =>
                      setSelectedCell({ row: cell.row, col: cell.col, text: cell.text })
                    }
                  >
                    <td>{cell.text}</td>
                    <td className="tabular">{cell.marginalSum.toFixed(3)}</td>
                    <td>
                      <div className="combo-bars" style={{ width: 120 }}>
                        {(mix ?? []).map((weight, index) =>
                          weight > 0.001 ? (
                            <span
                              key={index}
                              style={{
                                width: `${weight * 100}%`,
                                background: colors.byIndex[index],
                              }}
                            />
                          ) : null,
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    );
  }

  const model = categories?.model ?? "made-hand";
  const exclusive = categories?.exclusive !== false;
  const title =
    model === "draws" ? "Draw / backdoor categories" : "Made-hand categories";

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
