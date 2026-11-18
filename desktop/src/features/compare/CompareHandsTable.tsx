import { useMemo, useState } from "react";
import type { CompareHandRow } from "../../domain/locks";
import {
  absDeltaAt,
  formatDelta,
  formatProb,
  maxAbsDelta,
} from "./compareFormat";

export type HandFilter = "all" | "locked";
export type HandSort = "delta" | "combo";

interface Props {
  actions: string[];
  hands: CompareHandRow[];
  filter: HandFilter;
  sort: HandSort;
  onFilterChange: (filter: HandFilter) => void;
  onSortChange: (sort: HandSort) => void;
}

function actionValue(
  values: number[] | undefined,
  actionIndex: number,
): number | undefined {
  if (!values || actionIndex < 0 || actionIndex >= values.length) {
    return undefined;
  }
  return values[actionIndex];
}

/**
 * Compact Compare hands view: one action at a time with the combos that
 * changed most. Avoids the old 3×action wide table (20 cols with six actions).
 */
export function CompareHandsTable({
  actions,
  hands,
  filter,
  sort,
  onFilterChange,
  onSortChange,
}: Props) {
  const [expandedAction, setExpandedAction] = useState<number | null>(
    actions.length > 0 ? 0 : null,
  );

  const filtered = useMemo(
    () => (filter === "locked" ? hands.filter((hand) => hand.locked) : hands),
    [filter, hands],
  );

  const lockedCount = useMemo(
    () => hands.filter((hand) => hand.locked).length,
    [hands],
  );

  const rows = useMemo(() => {
    const sorted = [...filtered].sort((left, right) => {
      if (sort === "combo") {
        return left.combo.localeCompare(right.combo);
      }
      if (expandedAction != null) {
        const deltaDiff =
          absDeltaAt(right.delta, expandedAction) -
          absDeltaAt(left.delta, expandedAction);
        if (deltaDiff !== 0) {
          return deltaDiff;
        }
      }
      const deltaDiff = maxAbsDelta(right.delta) - maxAbsDelta(left.delta);
      if (deltaDiff !== 0) {
        return deltaDiff;
      }
      return left.combo.localeCompare(right.combo);
    });
    return sorted;
  }, [filtered, sort, expandedAction]);

  return (
    <section className="compare-table-panel" aria-label="Hand strategy compare">
      <div className="compare-table-toolbar">
        <div className="compare-filter-group" role="group" aria-label="Hand filter">
          <button
            type="button"
            className="toolbar-btn"
            data-active={filter === "all" ? "true" : "false"}
            aria-pressed={filter === "all"}
            onClick={() => onFilterChange("all")}
          >
            All hands
          </button>
          <button
            type="button"
            className="toolbar-btn"
            data-active={filter === "locked" ? "true" : "false"}
            aria-pressed={filter === "locked"}
            onClick={() => onFilterChange("locked")}
          >
            Locked only
          </button>
        </div>
        <label className="compare-sort">
          Sort
          <select
            value={sort}
            onChange={(event) => onSortChange(event.target.value as HandSort)}
          >
            <option value="delta">|Δ| max</option>
            <option value="combo">Combo</option>
          </select>
        </label>
        <span className="compare-table-count muted">
          {filter === "locked"
            ? `${rows.length} / ${lockedCount} locked`
            : `${rows.length} / ${hands.length} hands`}
          {lockedCount > 0 ? ` · ${lockedCount} locked` : ""}
        </span>
      </div>

      <div className="compare-action-tabs" role="tablist" aria-label="Action detail">
        {actions.map((label, actionIndex) => (
          <button
            key={label}
            type="button"
            role="tab"
            className="toolbar-btn"
            aria-selected={expandedAction === actionIndex}
            data-active={expandedAction === actionIndex ? "true" : "false"}
            onClick={() =>
              setExpandedAction((prev) =>
                prev === actionIndex ? null : actionIndex,
              )
            }
          >
            {label}
          </button>
        ))}
      </div>

      {expandedAction == null ? (
        <p className="compare-table-empty muted">
          Select an action to list combos that changed most.
        </p>
      ) : (
        <div className="compare-table-scroll">
          <table className="compare-table compare-table--compact">
            <thead>
              <tr>
                <th scope="col" className="compare-col-combo">
                  Combo
                </th>
                <th scope="col" className="compare-col-lock">
                  Lock
                </th>
                <th scope="col" className="compare-num">
                  Baseline
                </th>
                <th scope="col" className="compare-num">
                  Revised
                </th>
                <th scope="col" className="compare-num">
                  Δ
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="compare-table-empty">
                    {filter === "locked"
                      ? "No locked hands at this node."
                      : "No hands in compare payload."}
                  </td>
                </tr>
              ) : (
                rows.map((hand) => {
                  const baseline = actionValue(hand.baseline, expandedAction);
                  const scenario = actionValue(hand.scenario, expandedAction);
                  const delta = actionValue(hand.delta, expandedAction);
                  const deltaClass =
                    delta == null || !Number.isFinite(delta) || delta === 0
                      ? ""
                      : delta > 0
                        ? "compare-delta-pos"
                        : "compare-delta-neg";
                  return (
                    <tr
                      key={hand.combo}
                      data-locked={hand.locked ? "true" : "false"}
                    >
                      <td className="compare-col-combo">{hand.combo}</td>
                      <td className="compare-col-lock">
                        {hand.locked ? (
                          <span className="compare-lock-mark" title="Locked">
                            ●
                          </span>
                        ) : (
                          <span className="muted">·</span>
                        )}
                      </td>
                      <td className="compare-num tabular">
                        {formatProb(baseline)}
                      </td>
                      <td className="compare-num tabular">
                        {formatProb(scenario)}
                      </td>
                      <td className={`compare-num tabular ${deltaClass}`}>
                        {formatDelta(delta)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
