import { useMemo, useState } from "react";
import { parseCardCode } from "../../domain/cards";
import type { RunoutCardModel, RunoutsModel } from "../../engine/runouts";
import { useStudyStore } from "../../state/studyStore";

type SuitFilter = "all" | "s" | "h" | "d" | "c";
type SortKey = "card" | "probability" | "oopEv" | "ipEv";

function suitOf(card: string): string | undefined {
  return parseCardCode(card)?.suit;
}

function formatOptional(value: number | null | undefined, defined: boolean, digits: number): string {
  if (!defined || value == null || !Number.isFinite(value)) {
    return "—";
  }
  return value.toFixed(digits);
}

function sortValue(row: RunoutCardModel, key: SortKey): string | number | null {
  switch (key) {
    case "card":
      return row.card;
    case "probability":
      return row.probabilityDefined ? row.probability : null;
    case "oopEv":
      return row.evDefined ? row.oopEv : null;
    case "ipEv":
      return row.evDefined ? row.ipEv : null;
  }
}

export function RunoutTable() {
  const runouts = useStudyStore((s) => s.runouts) as RunoutsModel | { pending?: boolean } | null;
  const loadRunouts = useStudyStore((s) => s.loadRunouts);
  const followAction = useStudyStore((s) => s.followAction);
  const [sortKey, setSortKey] = useState<SortKey>("card");
  const [suitFilter, setSuitFilter] = useState<SuitFilter>("all");

  const model = runouts && "rows" in runouts ? (runouts as RunoutsModel) : null;
  const pending = Boolean(runouts && "pending" in runouts && runouts.pending);

  const rows = useMemo(() => {
    const list = (model?.rows ?? []).filter((row) => {
      if (suitFilter === "all") {
        return true;
      }
      const card = String(row.card || "");
      return card.length >= 2 && card[1]?.toLowerCase() === suitFilter;
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
  }, [model, sortKey, suitFilter]);

  const unitsLabel = [model?.units, model?.utilityBasis].filter(Boolean).join(" · ");

  return (
    <div className="runout-table">
      <div className="panel-title-row">
        <h2 className="panel-title">Runouts</h2>
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
          <button type="button" className="toolbar-btn" onClick={() => void loadRunouts()}>
            Refresh
          </button>
        </div>
      </div>
      {unitsLabel ? (
        <p className="empty-hint" data-testid="runout-units">
          EV units: {unitsLabel}
        </p>
      ) : null}
      {pending ? <p className="empty-hint">Loading…</p> : null}
      {!pending && !rows.length ? (
        <p className="empty-hint">Open a deal (next-card) node, then Refresh.</p>
      ) : null}
      {rows.length ? (
        <table>
          <thead>
            <tr>
              {(
                [
                  ["card", "Card"],
                  ["probability", "P"],
                  ["oopEv", "OOP EV"],
                  ["ipEv", "IP EV"],
                ] as const
              ).map(([key, label]) => (
                <th key={key}>
                  <button type="button" className="linkish" onClick={() => setSortKey(key)}>
                    {label}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.childId || row.card}
                className={row.childId ? "clickable" : undefined}
                data-child-id={row.childId || undefined}
                onClick={() => row.childId && void followAction(row.childId)}
              >
                <td className="runout-card" data-suit={suitOf(row.card)}>
                  {row.card}
                </td>
                <td className="tabular">
                  {formatOptional(row.probability, row.probabilityDefined, 4)}
                </td>
                <td className="tabular">{formatOptional(row.oopEv, row.evDefined, 2)}</td>
                <td className="tabular">{formatOptional(row.ipEv, row.evDefined, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
