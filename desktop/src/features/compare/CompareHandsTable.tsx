import { Fragment } from "react";
import type { CompareHandRow } from "../../domain/locks";
import { formatDelta, formatProb, maxAbsDelta } from "./compareFormat";

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

function SubheadCells() {
  return (
    <>
      <th scope="col" className="compare-num">
        Base
      </th>
      <th scope="col" className="compare-num">
        Scen
      </th>
      <th scope="col" className="compare-num">
        Δ
      </th>
    </>
  );
}

export function CompareHandsTable({
  actions,
  hands,
  filter,
  sort,
  onFilterChange,
  onSortChange,
}: Props) {
  const filtered = filter === "locked" ? hands.filter((hand) => hand.locked) : hands;

  const rows = [...filtered].sort((left, right) => {
    if (sort === "combo") {
      return left.combo.localeCompare(right.combo);
    }
    const deltaDiff = maxAbsDelta(right.delta) - maxAbsDelta(left.delta);
    if (deltaDiff !== 0) {
      return deltaDiff;
    }
    return left.combo.localeCompare(right.combo);
  });

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
          {rows.length} / {hands.length} hands
        </span>
      </div>

      <div className="compare-table-scroll">
        <table className="compare-table">
          <thead>
            <tr>
              <th scope="col" className="compare-col-combo">
                Combo
              </th>
              <th scope="col" className="compare-col-lock">
                Lock
              </th>
              {actions.map((label) => (
                <th key={label} scope="col" className="compare-col-action" colSpan={3}>
                  {label}
                </th>
              ))}
            </tr>
            <tr className="compare-subhead">
              <th aria-hidden="true" />
              <th aria-hidden="true" />
              {actions.map((label) => (
                <SubheadCells key={`sub-${label}`} />
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={2 + actions.length * 3} className="compare-table-empty">
                  {filter === "locked"
                    ? "No locked hands at this node."
                    : "No hands in compare payload."}
                </td>
              </tr>
            ) : (
              rows.map((hand) => (
                <tr key={hand.combo} data-locked={hand.locked ? "true" : "false"}>
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
                  {actions.map((label, actionIndex) => {
                    const baseline = actionValue(hand.baseline, actionIndex);
                    const scenario = actionValue(hand.scenario, actionIndex);
                    const delta = actionValue(hand.delta, actionIndex);
                    const deltaClass =
                      delta == null || !Number.isFinite(delta) || delta === 0
                        ? ""
                        : delta > 0
                          ? "compare-delta-pos"
                          : "compare-delta-neg";
                    return (
                      <Fragment key={`${hand.combo}-${label}`}>
                        <td className="compare-num tabular">{formatProb(baseline)}</td>
                        <td className="compare-num tabular">{formatProb(scenario)}</td>
                        <td className={`compare-num tabular ${deltaClass}`}>
                          {formatDelta(delta)}
                        </td>
                      </Fragment>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
