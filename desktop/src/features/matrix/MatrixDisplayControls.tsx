import { useEffect } from "react";
import {
  type MatrixCellOverlay,
  useMatrixDisplayStore,
} from "../../domain/matrixDisplay";
import { analysisPayloadMatchesNode } from "../../domain/setup/identity";
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
} | null;

/** True when a finished (non-pending) payload belongs to the live node. */
function analysisReady(
  payload: AnalysisPayload,
  solutionId: string | null | undefined,
  nodeId: string | null | undefined,
): boolean {
  return Boolean(
    payload &&
      !payload.pending &&
      analysisPayloadMatchesNode(payload, solutionId, nodeId),
  );
}

/** True when an in-flight pending payload is for the live node. */
function analysisPendingForNode(
  payload: AnalysisPayload,
  solutionId: string | null | undefined,
  nodeId: string | null | undefined,
): boolean {
  if (!payload?.pending || !solutionId || !nodeId) {
    return false;
  }
  if (payload.node_id != null && payload.node_id !== nodeId) {
    return false;
  }
  if (payload.solution_id != null && payload.solution_id !== solutionId) {
    return false;
  }
  return true;
}

/** Toggles for range-weight height fill and EV/equity cell overlays. */
export function MatrixDisplayControls() {
  const prefs = useMatrixDisplayStore((s) => s.prefs);
  const setRangeWeightHeightFill = useMatrixDisplayStore(
    (s) => s.setRangeWeightHeightFill,
  );
  const setCellOverlay = useMatrixDisplayStore((s) => s.setCellOverlay);
  const setColorByOverlay = useMatrixDisplayStore((s) => s.setColorByOverlay);
  const equity = useStudyStore((s) => s.equity) as AnalysisPayload;
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
  const equityReady = analysisReady(equity, solutionId, nodeId);
  const equityPending = analysisPendingForNode(equity, solutionId, nodeId);
  const evReady = analysisReady(nodeValues, solutionId, nodeId);
  const evPending = analysisPendingForNode(nodeValues, solutionId, nodeId);

  // Auto-compute when the overlay / EV mode needs analysis for the live node.
  // Explorer has one value worker: equity and /values cancel each other, so when
  // both are needed load equity first and only then request EV (ValueBluffsPanel same).
  useEffect(() => {
    if (!currentNode || !solutionId || !decisionNode) {
      return;
    }
    if (wantEquity && !equityReady && !equityPending) {
      void loadEquity();
    }
    const equityBlocking = wantEquity && !equityReady;
    if (wantEv && !evReady && !evPending && !equityBlocking) {
      void calculateEv();
    }
  }, [
    currentNode,
    solutionId,
    decisionNode,
    wantEquity,
    wantEv,
    equityReady,
    equityPending,
    evReady,
    evPending,
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
