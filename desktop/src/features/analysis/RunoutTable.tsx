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

export function RunoutTable() {
  const runouts = useStudyStore((s) => s.runouts) as {
    runouts?: RunoutRow[];
    pending?: boolean;
  } | null;
  const loadRunouts = useStudyStore((s) => s.loadRunouts);
  const followAction = useStudyStore((s) => s.followAction);
  const [sortKey, setSortKey] = useState<"card" | "weight" | "oop_ev" | "ip_ev">("card");

  const rows = useMemo(() => {
    const list = runouts?.runouts ?? [];
    return [...list].sort((left, right) => {
      const a = left[sortKey];
      const b = right[sortKey];
      if (typeof a === "string" && typeof b === "string") {
        return a.localeCompare(b);
      }
      return Number(a ?? 0) - Number(b ?? 0);
    });
  }, [runouts, sortKey]);

  return (
    <div className="runout-table">
      <div className="panel-title-row">
        <h2 className="panel-title">Runouts</h2>
        <button type="button" className="toolbar-btn" onClick={() => void loadRunouts()}>
          Refresh
        </button>
      </div>
      {runouts?.pending ? <p className="empty-hint">Pending…</p> : null}
      {!rows.length ? (
        <p className="empty-hint">Compare runouts on a chance node.</p>
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
