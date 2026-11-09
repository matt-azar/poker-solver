import { useMemo, useState } from "react";
import { parseCardCode } from "../../domain/cards";
import {
  aggregateActionFrequency,
  type LineCardReportRow,
} from "../../domain/lineCardReport";
import { useStudyStore } from "../../state/studyStore";

type SuitFilter = "all" | "s" | "h" | "d" | "c";
type SortKey = "card" | "deal" | "reach" | `action:${number}`;

function suitOf(card: string): string | undefined {
  return parseCardCode(card)?.suit;
}

function formatOptional(
  value: number | null | undefined,
  defined: boolean,
  digits: number,
): string {
  if (!defined || value == null || !Number.isFinite(value)) {
    return "—";
  }
  return value.toFixed(digits);
}

function formatPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return "—";
  }
  return `${(value * 100).toFixed(1)}%`;
}

function sortValue(
  row: LineCardReportRow,
  key: SortKey,
): string | number | null {
  if (key === "card") {
    return row.card;
  }
  if (key === "deal") {
    return row.dealProbabilityDefined ? row.dealProbability : null;
  }
  if (key === "reach") {
    return row.reachDefined ? row.reach : null;
  }
  if (key.startsWith("action:")) {
    const index = Number(key.slice("action:".length));
    if (!row.available) {
      return null;
    }
    const freq = row.frequencies[index];
    return freq != null && Number.isFinite(freq) ? freq : null;
  }
  return null;
}

export function LineCardReport() {
  const report = useStudyStore((s) => s.lineCardReport);
  const loadLineCardReport = useStudyStore((s) => s.loadLineCardReport);
  const openLineCardRow = useStudyStore((s) => s.openLineCardRow);
  const [sortKey, setSortKey] = useState<SortKey>("card");
  const [suitFilter, setSuitFilter] = useState<SuitFilter>("all");

  const rows = useMemo(() => {
    const list = (report?.rows ?? []).filter((row) => {
      if (suitFilter === "all") {
        return true;
      }
      return row.card.length >= 2 && row.card[1]?.toLowerCase() === suitFilter;
    });
    return [...list].sort((left, right) => {
      const a = sortValue(left, sortKey);
      const b = sortValue(right, sortKey);
      if (typeof a === "string" && typeof b === "string") {
        return a.localeCompare(b);
      }
      if (a == null && b == null) {
        return 0;
      }
      if (a == null) {
        return 1;
      }
      if (b == null) {
        return -1;
      }
      return Number(a) - Number(b);
    });
  }, [report, sortKey, suitFilter]);

  const aggregates = useMemo(() => {
    const labels = report?.actionLabels ?? [];
    return labels.map((_, index) =>
      aggregateActionFrequency(report?.rows ?? [], index),
    );
  }, [report]);

  if (!report) {
    return (
      <div className="runout-table line-card-report">
        <div className="panel-title-row">
          <h2 className="panel-title">Compare cards</h2>
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => void loadLineCardReport()}
          >
            Run report
          </button>
        </div>
        <p className="empty-hint">
          From a turn or river decision, compare the same betting line across
          cards. Deal probability and reach are separate columns.
        </p>
      </div>
    );
  }

  return (
    <div className="runout-table line-card-report">
      <div className="panel-title-row">
        <h2 className="panel-title">Compare cards</h2>
        <div className="panel-title-actions">
          <div className="seat-toggle" role="group" aria-label="Suit filter">
            {(["all", "s", "h", "d", "c"] as const).map((suit) => (
              <button
                key={suit}
                type="button"
                className="toolbar-btn"
                data-suit={suit === "all" ? undefined : suit}
                aria-pressed={suitFilter === suit}
                onClick={() => setSuitFilter(suit)}
              >
                {suit === "all" ? "All" : suit}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => void loadLineCardReport()}
          >
            Refresh
          </button>
        </div>
      </div>
      <p className="empty-hint" data-testid="line-card-line">
        {report.street} · {report.line}
      </p>
      {report.error ? <p className="tree-editor-error">{report.error}</p> : null}
      {report.pending ? <p className="empty-hint">Loading…</p> : null}
      {!report.pending && !rows.length && !report.error ? (
        <p className="empty-hint">No cards to compare at this deal.</p>
      ) : null}
      {rows.length ? (
        <table>
          <thead>
            <tr>
              <th>
                <button
                  type="button"
                  className="linkish"
                  onClick={() => setSortKey("card")}
                >
                  Card
                </button>
              </th>
              <th>
                <button
                  type="button"
                  className="linkish"
                  onClick={() => setSortKey("deal")}
                >
                  Deal P
                </button>
              </th>
              <th>
                <button
                  type="button"
                  className="linkish"
                  onClick={() => setSortKey("reach")}
                >
                  Reach
                </button>
              </th>
              {report.actionLabels.map((label, index) => (
                <th key={`${label}-${index}`}>
                  <button
                    type="button"
                    className="linkish"
                    onClick={() => setSortKey(`action:${index}`)}
                  >
                    {label}
                  </button>
                </th>
              ))}
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.card}
                className={row.resolvedNodeId ? "clickable" : undefined}
                data-available={row.available ? "true" : "false"}
                data-zero-reach={row.zeroReach ? "true" : undefined}
                onClick={() => {
                  if (row.resolvedNodeId) {
                    void openLineCardRow(row.resolvedNodeId);
                  }
                }}
              >
                <td className="runout-card" data-suit={suitOf(row.card)}>
                  {row.card}
                </td>
                <td className="tabular">
                  {formatOptional(
                    row.dealProbability,
                    row.dealProbabilityDefined,
                    4,
                  )}
                </td>
                <td className="tabular">
                  {formatOptional(row.reach, row.reachDefined, 4)}
                </td>
                {report.actionLabels.map((label, index) => (
                  <td key={`${row.card}-${label}`} className="tabular">
                    {row.frequencies.length > index
                      ? formatPct(row.frequencies[index])
                      : "—"}
                  </td>
                ))}
                <td>
                  {row.available
                    ? row.reason ?? "OK"
                    : row.reason ?? "Unavailable"}
                </td>
              </tr>
            ))}
          </tbody>
          {report.actionLabels.length ? (
            <tfoot>
              <tr>
                <td colSpan={3}>Reach-weighted mix</td>
                {aggregates.map((value, index) => (
                  <td key={`agg-${index}`} className="tabular">
                    {formatPct(value)}
                  </td>
                ))}
                <td />
              </tr>
            </tfoot>
          ) : null}
        </table>
      ) : null}
    </div>
  );
}
