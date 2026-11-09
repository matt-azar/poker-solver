import { useEffect } from "react";
import {
  type MatrixCellOverlay,
  useMatrixDisplayStore,
} from "../../domain/matrixDisplay";
import { analysisPayloadNeedsAutoload } from "../../domain/setup/identity";
import { useStudyStore } from "../../state/studyStore";

const OVERLAYS: Array<{ id: MatrixCellOverlay; label: string }> = [
  { id: "none", label: "Off" },
  { id: "ev", label: "EV" },
  { id: "equity", label: "Eq" },
  { id: "both", label: "EV+Eq" },
];

type AnalysisPayload = {
  pending?: boolean;
  node_id?: string;
  solution_id?: string;
  error?: string;
} | null;

/** Toggles for range-weight height fill and EV/equity cell overlays. */
export function MatrixDisplayControls() {
  const prefs = useMatrixDisplayStore((s) => s.prefs);
  const setRangeWeightHeightFill = useMatrixDisplayStore(
    (s) => s.setRangeWeightHeightFill,
  );
  const setCellOverlay = useMatrixDisplayStore((s) => s.setCellOverlay);
  const setColorByOverlay = useMatrixDisplayStore((s) => s.setColorByOverlay);
  const equity = useStudyStore((s) => s.equity) as AnalysisPayload;
  const ensureNodeAnalysis = useStudyStore((s) => s.ensureNodeAnalysis);
  const loadEquity = useStudyStore((s) => s.loadEquity);
  const calculateEv = useStudyStore((s) => s.calculateEv);
  const nodeValues = useStudyStore((s) => s.nodeValues);
  const currentNode = useStudyStore((s) => s.currentNode);
  const solutionId = useStudyStore((s) => s.solutionId);
  const matrixMode = useStudyStore((s) => s.matrixMode);

  const nodeId = currentNode?.node_id ?? null;
  // Skip chance/terminal; treat missing kind with actions as a decision (fixtures).
  const decisionNode =
    currentNode != null &&
    currentNode.kind !== "chance" &&
    currentNode.kind !== "terminal" &&
    (currentNode.kind === "decision" ||
      currentNode.kind == null ||
      (currentNode.actions?.length ?? 0) > 0);
  const wantEquity = prefs.cellOverlay === "equity" || prefs.cellOverlay === "both";
  // Overlay EV, EV matrix mode, or strategy+EV after a prior calc all need /values.
  const wantEv =
    decisionNode &&
    (prefs.cellOverlay === "ev" ||
      prefs.cellOverlay === "both" ||
      matrixMode === "ev" ||
      matrixMode === "strategy-ev");
  const needEquity = wantEquity && analysisPayloadNeedsAutoload(equity, solutionId, nodeId);
  const needEv = wantEv && analysisPayloadNeedsAutoload(nodeValues, solutionId, nodeId);
  const equityPending = Boolean(
    equity?.pending &&
      (!equity.node_id || equity.node_id === nodeId) &&
      (!equity.solution_id || equity.solution_id === solutionId),
  );
  const evPending = Boolean(
    nodeValues?.pending &&
      (!nodeValues.node_id || nodeValues.node_id === nodeId) &&
      (!nodeValues.solution_id || nodeValues.solution_id === solutionId),
  );

  // Overlay / EV mode requests funnel through the Study selection owner. Always-on
  // warm already covers decision nodes; this catches overlay toggles and retries
  // without sequencing equity ahead of EV (the worker queue accepts both).
  useEffect(() => {
    if (!currentNode || !solutionId || !decisionNode) {
      return;
    }
    if (needEquity && needEv) {
      void ensureNodeAnalysis();
      return;
    }
    if (needEquity) {
      void loadEquity();
    }
    if (needEv) {
      void calculateEv();
    }
  }, [
    currentNode,
    solutionId,
    decisionNode,
    needEquity,
    needEv,
    ensureNodeAnalysis,
    loadEquity,
    calculateEv,
  ]);

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
      {equityPending ? <span className="muted tabular">Eq…</span> : null}
      {evPending ? <span className="muted tabular">EV…</span> : null}
    </div>
  );
}
