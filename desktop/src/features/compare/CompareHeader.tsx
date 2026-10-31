import type { ComparePayload } from "../../domain/locks";
import { formatChipEv, formatNashGap, shortId } from "./compareFormat";

interface Props {
  note: ComparePayload;
}

export function CompareHeader({ note }: Props) {
  const deltaClass =
    note.value_delta === 0
      ? ""
      : note.value_delta > 0
        ? "compare-delta-pos"
        : "compare-delta-neg";

  return (
    <header className="compare-header">
      <div className="compare-header__ids">
        <div className="compare-id-block">
          <span className="compare-label">Baseline</span>
          <code className="compare-id">{shortId(note.baseline_id)}</code>
        </div>
        <span className="compare-vs muted" aria-hidden="true">
          vs
        </span>
        <div className="compare-id-block">
          <span className="compare-label">Scenario</span>
          <code className="compare-id">{shortId(note.scenario_id)}</code>
        </div>
        <div className="compare-id-block">
          <span className="compare-label">Node</span>
          <code className="compare-id">{shortId(note.node_id)}</code>
        </div>
      </div>

      <div className="compare-metrics" aria-label="Root-centered chip EV">
        <div className="compare-metric">
          <span className="compare-label">Baseline EV</span>
          <span className="compare-metric__value tabular">
            {formatChipEv(note.baseline_value)}
          </span>
        </div>
        <div className="compare-metric">
          <span className="compare-label">Scenario EV</span>
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
          <span className="compare-label">Scenario NashConv</span>
          <span className="compare-metric__value tabular">
            {formatNashGap(note.scenario_nash_gap)}
          </span>
        </div>
      </div>

      <p className="compare-utility-note">
        Utility is <strong>root-centered chips</strong> (including earlier investments) — not Pio
        exploitability. Nash gaps are NashConv (sum of best-response gains), not averaged
        exploitability.
      </p>
    </header>
  );
}
