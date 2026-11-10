import { useEffect, useMemo, useRef, useState } from "react";
import { SUIT_SYMBOLS } from "../../domain/cards";
import { mapActionColors } from "../../domain/actionColors";
import {
  LINE_CARD_GRID_RANKS,
  LINE_CARD_GRID_SUITS,
  lineCardEquityFromPayload,
  lineCardEvFromValues,
  type LineCardMetric,
  type LineCardReportRow,
} from "../../domain/lineCardReport";
import type { EvDisplayBasis } from "../../domain/types";
import { engineClient } from "../../engine/client";
import { useStudyStore } from "../../state/studyStore";

const METRICS: Array<{ id: LineCardMetric; label: string }> = [
  { id: "frequencies", label: "Frequencies" },
  { id: "ev", label: "EV" },
  { id: "equity", label: "Equity" },
  { id: "deal", label: "Deal probability" },
];

interface CellExtra {
  ev: number | null;
  evDefined: boolean;
  equity: number | null;
  equityDefined: boolean;
  evSettled: boolean;
  equitySettled: boolean;
}

function formatPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return "—";
  }
  return `${(value * 100).toFixed(1)}%`;
}

function formatEv(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return "—";
  }
  return value.toFixed(1);
}

async function loadSettled<T extends { pending?: boolean }>(
  load: () => Promise<T>,
  isCancelled: () => boolean,
): Promise<T | null> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (isCancelled()) {
      return null;
    }
    const body = await load();
    if (isCancelled()) {
      return null;
    }
    if (!body?.pending) {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

function frequencyBar(freqs: number[], colors: string[]): string | undefined {
  if (!freqs.length) {
    return undefined;
  }
  let cursor = 0;
  const stops: string[] = [];
  freqs.forEach((freq, index) => {
    const next = Math.min(100, cursor + Math.max(0, freq) * 100);
    const color = colors[index] ?? "var(--muted)";
    if (next > cursor) {
      stops.push(`${color} ${cursor}% ${next}%`);
    }
    cursor = next;
  });
  if (!stops.length) {
    return undefined;
  }
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

export function LineCardReport() {
  const report = useStudyStore((s) => s.lineCardReport);
  const loadLineCardReport = useStudyStore((s) => s.loadLineCardReport);
  const openLineCardRow = useStudyStore((s) => s.openLineCardRow);
  const evDisplayBasis =
    (useStudyStore((s) => s.evDisplayBasis) as EvDisplayBasis | undefined) ?? "local";
  const [metric, setMetric] = useState<LineCardMetric>("frequencies");
  const [extras, setExtras] = useState<Record<string, CellExtra>>({});
  const reportRef = useRef(report);
  useEffect(() => {
    reportRef.current = report;
  });

  const byCard = useMemo(() => {
    const map = new Map<string, LineCardReportRow>();
    for (const row of report?.rows ?? []) {
      map.set(row.card, row);
    }
    return map;
  }, [report]);

  const colors = useMemo(
    () => mapActionColors(report?.actionLabels ?? []),
    [report?.actionLabels],
  );

  useEffect(() => {
    setExtras({});
  }, [report?.reportNodeId, report?.solutionId, report?.line]);

  useEffect(() => {
    const current = reportRef.current;
    if (!current?.solutionId || (metric !== "ev" && metric !== "equity")) {
      return;
    }
    const solutionId = current.solutionId;
    const targets = current.rows.filter((row) => {
      if (!row.available || !row.resolvedNodeId) {
        return false;
      }
      if (metric === "ev") {
        return !row.evDefined;
      }
      return !row.equityDefined;
    });
    if (!targets.length) {
      return;
    }
    let cancelled = false;
    void (async () => {
      for (const row of targets) {
        if (cancelled || !row.resolvedNodeId) {
          return;
        }
        try {
          if (metric === "ev") {
            const values = await loadSettled(
              () => engineClient.getValues(solutionId, row.resolvedNodeId!),
              () => cancelled,
            );
            if (cancelled) {
              return;
            }
            const ev = values
              ? lineCardEvFromValues(values, evDisplayBasis, current.actionLabels)
              : null;
            setExtras((prev) => ({
              ...prev,
              [row.card]: {
                ev,
                evDefined: ev != null,
                equity: prev[row.card]?.equity ?? null,
                equityDefined: prev[row.card]?.equityDefined ?? false,
                evSettled: true,
                equitySettled: prev[row.card]?.equitySettled ?? false,
              },
            }));
          } else {
            const payload = await loadSettled(
              () =>
                engineClient.getEquity(solutionId, row.resolvedNodeId!) as Promise<{
                  pending?: boolean;
                }>,
              () => cancelled,
            );
            if (cancelled) {
              return;
            }
            const equity = lineCardEquityFromPayload(payload, row.player);
            setExtras((prev) => ({
              ...prev,
              [row.card]: {
                ev: prev[row.card]?.ev ?? null,
                evDefined: prev[row.card]?.evDefined ?? false,
                equity,
                equityDefined: equity != null,
                evSettled: prev[row.card]?.evSettled ?? false,
                equitySettled: true,
              },
            }));
          }
        } catch {
          if (cancelled) {
            return;
          }
          setExtras((prev) => ({
            ...prev,
            [row.card]: {
              ev: prev[row.card]?.ev ?? null,
              evDefined: prev[row.card]?.evDefined ?? false,
              equity: prev[row.card]?.equity ?? null,
              equityDefined: prev[row.card]?.equityDefined ?? false,
              evSettled: metric === "ev" ? true : (prev[row.card]?.evSettled ?? false),
              equitySettled:
                metric === "equity" ? true : (prev[row.card]?.equitySettled ?? false),
            },
          }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    metric,
    evDisplayBasis,
    report?.solutionId,
    report?.reportNodeId,
    report?.line,
    report?.pending,
  ]);

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
          cards on a suit-and-rank grid.
        </p>
      </div>
    );
  }

  const cellValue = (row: LineCardReportRow | undefined): string => {
    if (!row) {
      return "—";
    }
    if (metric === "deal") {
      return formatPct(
        row.dealProbabilityDefined ? row.dealProbability : null,
      );
    }
    if (!row.available) {
      return row.reason ?? "Unavailable";
    }
    if (metric === "ev") {
      if (row.evDefined) {
        return formatEv(row.ev);
      }
      const extra = extras[row.card];
      if (!extra?.evSettled) {
        return "…";
      }
      return formatEv(extra.ev);
    }
    if (metric === "equity") {
      if (row.equityDefined) {
        return formatPct(row.equity);
      }
      const extra = extras[row.card];
      if (!extra?.equitySettled) {
        return "…";
      }
      return formatPct(extra.equity);
    }
    return "";
  };

  return (
    <div className="runout-table line-card-report">
      <div className="panel-title-row">
        <h2 className="panel-title">Compare cards</h2>
        <div className="panel-title-actions">
          <div className="seat-toggle" role="group" aria-label="Card values">
            {METRICS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="toolbar-btn"
                aria-pressed={metric === entry.id}
                onClick={() => setMetric(entry.id)}
              >
                {entry.label}
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
        {metric === "ev"
          ? " · EV in chips"
          : metric === "equity"
            ? " · check-down equity"
            : metric === "deal"
              ? " · chance of dealing the card"
              : ""}
      </p>
      {metric === "frequencies" && colors.legend.length ? (
        <div className="line-card-legend" aria-label="Actions">
          {colors.legend.map((entry) => (
            <span key={entry.label} className="line-card-legend__item">
              <span
                className="line-card-legend__swatch"
                style={{ background: entry.color }}
                aria-hidden
              />
              {entry.label}
            </span>
          ))}
        </div>
      ) : null}
      {report.error ? <p className="tree-editor-error">{report.error}</p> : null}
      {report.pending ? <p className="empty-hint">Loading…</p> : null}
      <div className="line-card-grid-scroll">
        <div
          className="line-card-grid"
          role="grid"
          aria-label="Compare cards by suit and rank"
          data-metric={metric}
        >
          <div className="line-card-grid__row" role="row">
            <span className="line-card-grid__corner" />
            {LINE_CARD_GRID_RANKS.map((rank) => (
              <span key={rank} className="line-card-grid__rank" role="columnheader">
                {rank}
              </span>
            ))}
          </div>
          {LINE_CARD_GRID_SUITS.map((suit) => (
            <div key={suit} className="line-card-grid__row" role="row" data-suit={suit}>
              <span
                className="line-card-grid__suit"
                role="rowheader"
                data-suit={suit}
              >
                {SUIT_SYMBOLS[suit]}
              </span>
              {LINE_CARD_GRID_RANKS.map((rank) => {
                const code = `${rank}${suit}`;
                const row = byCard.get(code);
                const value = cellValue(row);
                const bar =
                  metric === "frequencies" && row?.available
                    ? frequencyBar(row.frequencies, colors.byIndex)
                    : undefined;
                return (
                  <button
                    key={code}
                    type="button"
                    role="gridcell"
                    className="line-card-cell"
                    data-suit={suit}
                    data-available={row?.available ? "true" : "false"}
                    disabled={!row?.resolvedNodeId}
                    title={
                      row
                        ? `${code}${row.reason ? ` · ${row.reason}` : ""}`
                        : `${code} not in this deal`
                    }
                    onClick={() => {
                      if (row?.resolvedNodeId) {
                        void openLineCardRow(row.resolvedNodeId);
                      }
                    }}
                  >
                    <span className="line-card-cell__card">{code}</span>
                    {metric === "frequencies" && row?.available ? (
                      <span className="line-card-cell__freqs">
                        {row.frequencies.map((freq, index) => (
                          <span key={`${code}-f-${index}`} className="line-card-cell__freq">
                            {formatPct(freq)}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="line-card-cell__value">{value}</span>
                    )}
                    {bar ? (
                      <span className="line-card-cell__bar" style={{ background: bar }} />
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
