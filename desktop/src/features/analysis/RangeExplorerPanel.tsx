import { useMemo, useState } from "react";
import { categorySeatView, normalizeBucketWeights } from "../../domain/analysis";
import { mapActionColors } from "../../domain/actionColors";
import { groupHands, strategyMix } from "../../domain/browse";
import { useStudyStore } from "../../state/studyStore";

interface CategoryPayload {
  available?: boolean;
  reason?: string;
  model?: string;
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
}

function EquityHistogram({
  title,
  buckets,
}: {
  title: string;
  buckets: Array<{ lo: number; hi: number; weight: number }> | undefined;
}) {
  const rows = useMemo(() => normalizeBucketWeights(buckets), [buckets]);
  if (!rows.length) {
    return <p className="empty-hint">{title}: no distribution buckets.</p>;
  }
  return (
    <div className="equity-hist">
      <h3 className="panel-subtitle">{title}</h3>
      <p className="hint">Mass convention: engine input weights (normalized for bar width).</p>
      <div className="equity-bars" role="img" aria-label={`${title} equity histogram`}>
        {rows.map((bucket) => (
          <div key={`${bucket.lo}-${bucket.hi}`} className="equity-bar-row">
            <span className="tabular muted">
              {bucket.lo.toFixed(1)}–{bucket.hi.toFixed(1)}
            </span>
            <span className="equity-bar-track">
              <span
                className="equity-bar"
                style={{ width: `${Math.min(100, bucket.fraction * 100)}%` }}
              />
            </span>
            <span className="tabular" title={`raw weight ${bucket.weight}`}>
              {(bucket.fraction * 100).toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
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

  if (analysisTab === "equity") {
    return (
      <div className="range-explorer">
        <div className="panel-title-row">
          <h2 className="panel-title">Check-down equity</h2>
          <button type="button" className="toolbar-btn" onClick={() => void loadEquity()}>
            Refresh
          </button>
        </div>
        {!equity ? (
          <p className="empty-hint">Request equity for the current node.</p>
        ) : equity.pending ? (
          <p className="empty-hint">Pending…</p>
        ) : (
          <>
            <p className="hint">
              Model: {equity.model || "check-down"} · Units:{" "}
              {equity.units || "fraction of pot"} · not chip EV
            </p>
            <div className="inspector-meta">
              <div>
                <span className="muted">OOP</span>
                <strong className="tabular">
                  {equity.oop_equity == null ? "—" : equity.oop_equity.toFixed(4)}
                </strong>
              </div>
              <div>
                <span className="muted">IP</span>
                <strong className="tabular">
                  {equity.ip_equity == null ? "—" : equity.ip_equity.toFixed(4)}
                </strong>
              </div>
            </div>
            <div className="equity-hist-grid">
              <EquityHistogram title="OOP distribution" buckets={equity.equity_distribution} />
              <EquityHistogram title="IP distribution" buckets={equity.ip_equity_distribution} />
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
          <span className="muted">Heaviest groups at this node</span>
        </div>
        {!topCells.length ? (
          <p className="empty-hint">Range mass appears after a solve.</p>
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

  return (
    <div className="range-explorer">
      <div className="panel-title-row">
        <h2 className="panel-title">Made-hand categories</h2>
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
        <p className="empty-hint">Available on five-card boards after solve.</p>
      ) : categories.pending ? (
        <p className="empty-hint">Pending…</p>
      ) : categories.available === false ? (
        <p className="empty-hint">{categories.reason || "Not available on this board."}</p>
      ) : (
        <>
          <p className="hint">
            Model: {categories.model || "made-hand"} · strategy-weighted reach
            {categoryView.totalMass != null
              ? ` · total mass ${categoryView.totalMass.toFixed(3)}`
              : ""}
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
