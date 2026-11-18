import {
  compareActionAggregates,
  compareActorLabel,
  compareChangeDescription,
  formatCompareBoard,
  type ComparePayload,
} from "../../domain/locks";
import { formatChipEv, formatNashGap, formatDelta, formatProb, shortId } from "./compareFormat";

interface Props {
  note: ComparePayload;
  /** Betting line label from the live Study node when available. */
  lineLabel?: string | null;
}

export function CompareHeader({ note, lineLabel }: Props) {
  const summary = compareActionAggregates(note);
  const change = compareChangeDescription(summary);
  const deltaClass =
    note.value_delta === 0
      ? ""
      : note.value_delta > 0
        ? "compare-delta-pos"
        : "compare-delta-neg";
  const actor = compareActorLabel(note.player);
  const board = formatCompareBoard(note.board);
  const line = lineLabel?.trim() || note.node_id;

  return (
    <header className="compare-header">
      <div className="compare-header__lead" aria-label="Compare context">
        <div className="compare-context-block">
          <span className="compare-label">Board</span>
          <span className="compare-context-value tabular">{board}</span>
        </div>
        <div className="compare-context-block">
          <span className="compare-label">Line</span>
          <span className="compare-context-value">{line}</span>
        </div>
        <div className="compare-context-block">
          <span className="compare-label">Actor</span>
          <span className="compare-context-value">{actor}</span>
        </div>
        <div className="compare-context-block compare-context-block--grow">
          <span className="compare-label">Change</span>
          <span className="compare-context-value">{change}</span>
        </div>
      </div>

      <div className="compare-action-summary" aria-label="Action frequency changes">
        <table className="compare-action-table">
          <thead>
            <tr>
              <th scope="col">Action</th>
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
            {summary.map((row) => {
              const rowDeltaClass =
                row.delta === 0
                  ? ""
                  : row.delta > 0
                    ? "compare-delta-pos"
                    : "compare-delta-neg";
              return (
                <tr key={row.action}>
                  <td>{row.action}</td>
                  <td className="compare-num tabular">{formatProb(row.baseline)}</td>
                  <td className="compare-num tabular">{formatProb(row.scenario)}</td>
                  <td className={`compare-num tabular ${rowDeltaClass}`}>
                    {formatDelta(row.delta)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="compare-utility-note">
          Frequencies are range-weighted with each strategy’s own node weights.
        </p>
      </div>

      <div className="compare-metrics" aria-label="Root OOP EV in chips">
        <div className="compare-metric">
          <span className="compare-label">Baseline EV</span>
          <span className="compare-metric__value tabular">
            {formatChipEv(note.baseline_value)}
          </span>
        </div>
        <div className="compare-metric">
          <span className="compare-label">Revised EV</span>
          <span className="compare-metric__value tabular">
            {formatChipEv(note.scenario_value)}
          </span>
        </div>
        <div className="compare-metric">
          <span className="compare-label">Δ EV</span>
          <span className={`compare-metric__value tabular ${deltaClass}`}>
            {formatChipEv(note.value_delta)}
          </span>
        </div>
        <div className="compare-metric">
          <span className="compare-label">Baseline NashConv</span>
          <span className="compare-metric__value tabular">
            {formatNashGap(note.baseline_nash_gap)}
          </span>
        </div>
        <div className="compare-metric">
          <span className="compare-label">Revised NashConv</span>
          <span className="compare-metric__value tabular">
            {formatNashGap(note.scenario_nash_gap)}
          </span>
        </div>
      </div>
      <p className="compare-utility-note">
        Root OOP EV in chips
        {note.utility_basis ? ` (${note.utility_basis})` : ""} — solution-level,
        not the selected node’s mixed EV.
      </p>

      <details className="compare-details">
        <summary>Session and node IDs</summary>
        <div className="compare-header__ids">
          <div className="compare-id-block">
            <span className="compare-label">Baseline</span>
            <code className="compare-id">{shortId(note.baseline_id)}</code>
          </div>
          <span className="compare-vs muted" aria-hidden="true">
            vs
          </span>
          <div className="compare-id-block">
            <span className="compare-label">Revised</span>
            <code className="compare-id">{shortId(note.scenario_id)}</code>
          </div>
          <div className="compare-id-block">
            <span className="compare-label">Node</span>
            <code className="compare-id">{shortId(note.node_id)}</code>
          </div>
          {note.pot != null ? (
            <div className="compare-id-block">
              <span className="compare-label">Pot</span>
              <span className="compare-context-value tabular">{note.pot}</span>
            </div>
          ) : null}
        </div>
      </details>
    </header>
  );
}
