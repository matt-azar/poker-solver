import { useMemo, useState } from "react";
import { useStudyStore } from "../../state/studyStore";

interface RunoutRow {
  card?: string;
  weight?: number | null;
  oop_ev?: number | null;
  ip_ev?: number | null;
  node_id?: string;
  [key: string]: unknown;
}

type SuitFilter = "all" | "s" | "h" | "d" | "c";

export function RunoutTable() {
  const runouts = useStudyStore((s) => s.runouts) as {
    runouts?: RunoutRow[];
    pending?: boolean;
  } | null;
  const loadRunouts = useStudyStore((s) => s.loadRunouts);
  const followAction = useStudyStore((s) => s.followAction);
  const [sortKey, setSortKey] = useState<"card" | "weight" | "oop_ev" | "ip_ev">("card");
  const [suitFilter, setSuitFilter] = useState<SuitFilter>("all");

  const rows = useMemo(() => {
    const list = (runouts?.runouts ?? []).filter((row) => {
      if (suitFilter === "all") {
        return true;
      }
      const card = String(row.card || "");
      return card.length >= 2 && card[1]?.toLowerCase() === suitFilter;
    });
    return [...list].sort((left, right) => {
      const a = left[sortKey];
      const b = right[sortKey];
      if (typeof a === "string" && typeof b === "string") {
        return a.localeCompare(b);
      }
      return Number(a ?? 0) - Number(b ?? 0);
    });
  }, [runouts, sortKey, suitFilter]);

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
      {runouts?.pending ? <p className="empty-hint">Loading…</p> : null}
      {!rows.length ? (
        <p className="empty-hint">Open a chance node, then Refresh.</p>
      ) : (
        <table>
          <thead>
            <tr>
              {(
                [
                  ["card", "Card"],
                  ["weight", "P"],
                  ["oop_ev", "OOP EV"],
                  ["ip_ev", "IP EV"],
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
                key={row.card || row.node_id}
                className={row.node_id ? "clickable" : undefined}
                onClick={() => row.node_id && void followAction(String(row.node_id))}
              >
                <td>{row.card}</td>
                <td className="tabular">
                  {row.weight == null ? "—" : Number(row.weight).toFixed(4)}
                </td>
                <td className="tabular">
                  {row.oop_ev == null ? "—" : Number(row.oop_ev).toFixed(2)}
                </td>
                <td className="tabular">
                  {row.ip_ev == null ? "—" : Number(row.ip_ev).toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
