import {
  type MatrixCellOverlay,
  useMatrixDisplayStore,
} from "../../domain/matrixDisplay";
import { useStudyStore } from "../../state/studyStore";

const OVERLAYS: Array<{ id: MatrixCellOverlay; label: string }> = [
  { id: "none", label: "Off" },
  { id: "ev", label: "EV" },
  { id: "equity", label: "Eq" },
  { id: "both", label: "EV+Eq" },
];

/** Toggles for range-weight height fill and EV/equity cell overlays. */
export function MatrixDisplayControls() {
  const prefs = useMatrixDisplayStore((s) => s.prefs);
  const setRangeWeightHeightFill = useMatrixDisplayStore(
    (s) => s.setRangeWeightHeightFill,
  );
  const setCellOverlay = useMatrixDisplayStore((s) => s.setCellOverlay);
  const setColorByOverlay = useMatrixDisplayStore((s) => s.setColorByOverlay);
  const equity = useStudyStore((s) => s.equity) as { pending?: boolean } | null;
  const loadEquity = useStudyStore((s) => s.loadEquity);
  const calculateEv = useStudyStore((s) => s.calculateEv);
  const nodeValues = useStudyStore((s) => s.nodeValues);
  const currentNode = useStudyStore((s) => s.currentNode);

  const equityReady = Boolean(equity && !equity.pending);
  const equityPending = Boolean(equity?.pending);
  const needsEquity =
    (prefs.cellOverlay === "equity" || prefs.cellOverlay === "both") &&
    !equityReady &&
    !equityPending;
  const needsEv =
    (prefs.cellOverlay === "ev" || prefs.cellOverlay === "both") &&
    (!nodeValues || nodeValues.pending);

  return (
    <div className="matrix-display-controls" role="group" aria-label="Matrix display">
      <button
        type="button"
        className="mode-btn"
        aria-pressed={prefs.rangeWeightHeightFill}
        title="Fill cell height by range inclusion weight"
        onClick={() => setRangeWeightHeightFill(!prefs.rangeWeightHeightFill)}
      >
        Weight fill
      </button>
      <div className="matrix-display-controls__overlay">
        <span className="matrix-display-controls__label muted" id="matrix-overlay-label">
          Overlay
        </span>
        <select
          className="matrix-display-controls__select"
          aria-labelledby="matrix-overlay-label"
          value={prefs.cellOverlay}
          onChange={(event) =>
            setCellOverlay(event.target.value as MatrixCellOverlay)
          }
        >
          {OVERLAYS.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </div>
      <button
        type="button"
        className="mode-btn"
        aria-pressed={prefs.colorByOverlay}
        disabled={prefs.cellOverlay === "none"}
        title="Tint cells by overlay value"
        onClick={() => setColorByOverlay(!prefs.colorByOverlay)}
      >
        Color
      </button>
      {needsEquity && currentNode ? (
        <button
          type="button"
          className="mode-btn"
          title="Load check-down equity for overlay"
          onClick={() => void loadEquity()}
        >
          Load Eq
        </button>
      ) : null}
      {needsEv && currentNode ? (
        <button
          type="button"
          className="mode-btn"
          title="Calculate action EVs for overlay"
          onClick={() => void calculateEv()}
        >
          Load EV
        </button>
      ) : null}
      {equityPending ? <span className="muted tabular">Eq…</span> : null}
    </div>
  );
}
