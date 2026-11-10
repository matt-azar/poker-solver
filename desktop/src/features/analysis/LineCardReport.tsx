import { useEffect, useMemo, useRef, useState } from "react";
import { studyLineLabel } from "../../domain/actionHistory";
import { parseCardCode, SUIT_SYMBOLS, suitSymbol } from "../../domain/cards";
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

/** Red (low) → green (high) fill for compare-runout EV and equity cells. */
export function lineCardHeatColor(value: number, min: number, max: number): string {
  const span = max - min;
  const t = span === 0 ? 0.5 : (value - min) / span;
  const clamped = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0.5));
  const hue = Math.round(clamped * 120);
  return `hsl(${hue} 62% 34%)`;
}

function cardFace(code: string): { rank: string; suit: string; symbol: string } | null {
  const parsed = parseCardCode(code);
  if (!parsed?.rank || !parsed.suit) {
    return null;
  }
  return {
    rank: parsed.rank,
    suit: parsed.suit,
    symbol: suitSymbol(parsed.suit) || parsed.suit,
  };
}

function actingSeat(rows: LineCardReportRow[]): "OOP" | "IP" | null {
  for (const row of rows) {
    if (row.player === 0) {
      return "OOP";
    }
    if (row.player === 1) {
      return "IP";
    }
  }
  return null;
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
  const pathTrail = useStudyStore((s) => s.pathTrail);
  const draftPot = useStudyStore((s) => s.draft?.pot);
  const statusPot = useStudyStore((s) => s.status?.pot);
  const rootPot = Number(draftPot ?? statusPot ?? 0);
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

  const lineText = useMemo(
    () =>
      studyLineLabel({
        trail: pathTrail,
        line: report?.line,
        currentNodeId: report?.reportNodeId,
        rootPot,
      }),
    [pathTrail, report?.line, report?.reportNodeId, rootPot],
  );

  const seat = useMemo(() => actingSeat(report?.rows ?? []), [report?.rows]);

  const heatByCard = useMemo(() => {
    const map = new Map<string, string>();
    if (metric !== "ev" && metric !== "equity") {
      return map;
    }
    const values: Array<{ card: string; value: number }> = [];
    for (const row of report?.rows ?? []) {
      if (!row.available) {
        continue;
      }
      let value: number | null = null;
      if (metric === "ev") {
        if (row.evDefined && row.ev != null && Number.isFinite(row.ev)) {
          value = row.ev;
        } else if (
          extras[row.card]?.evSettled &&
          extras[row.card]?.ev != null &&
          Number.isFinite(extras[row.card]?.ev)
        ) {
          value = extras[row.card]!.ev;
        }
      } else if (row.equityDefined && row.equity != null && Number.isFinite(row.equity)) {
        value = row.equity;
      } else if (
        extras[row.card]?.equitySettled &&
        extras[row.card]?.equity != null &&
        Number.isFinite(extras[row.card]?.equity)
      ) {
        value = extras[row.card]!.equity;
      }
      if (value != null) {
        values.push({ card: row.card, value });
      }
    }
    if (!values.length) {
      return map;
    }
    let min = values[0]!.value;
    let max = min;
    for (const entry of values) {
      min = Math.min(min, entry.value);
      max = Math.max(max, entry.value);
    }
    for (const entry of values) {
      map.set(entry.card, lineCardHeatColor(entry.value, min, max));
    }
    return map;
  }, [extras, metric, report?.rows]);

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
          <h2 className="panel-title">Compare runouts</h2>
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
        <h2 className="panel-title">Compare runouts</h2>
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
      <p className="empty-hint line-card-summary" data-testid="line-card-line">
        <span className="line-card-summary__line">{lineText}</span>
        {seat ? (
          <span className="line-card-seat" data-testid="line-card-seat">
            {seat}
          </span>
        ) : null}
        {metric === "ev" ? (
          <span className="line-card-summary__metric">EV in chips</span>
        ) : metric === "equity" ? (
          <span className="line-card-summary__metric">Equity</span>
        ) : metric === "deal" ? (
          <span className="line-card-summary__metric">Probability of the card being dealt</span>
        ) : null}
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
          aria-label="Compare runouts by suit and rank"
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
                const face = cardFace(code);
                const heat = row?.available ? heatByCard.get(code) : undefined;
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
                    data-card={code}
                    data-suit={suit}
                    data-available={row?.available ? "true" : "false"}
                    data-heat={heat ? "true" : "false"}
                    data-heat-color={heat ?? ""}
                    disabled={!row?.resolvedNodeId}
                    title={
                      row
                        ? `${code}${row.reason ? ` · ${row.reason}` : ""}`
                        : `${code} not in this deal`
                    }
                    style={heat ? { backgroundColor: heat } : undefined}
                    onClick={() => {
                      if (row?.resolvedNodeId) {
                        void openLineCardRow(row.resolvedNodeId);
                      }
                    }}
                  >
                    <span className="line-card-cell__badge">
                      {face ? (
                        <span className="line-card-cell__badge-card" data-suit={face.suit}>
                          <span className="line-card-cell__badge-rank">{face.rank}</span>
                          <span className="line-card-cell__badge-suit">{face.symbol}</span>
                        </span>
                      ) : (
                        code
                      )}
                    </span>
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
