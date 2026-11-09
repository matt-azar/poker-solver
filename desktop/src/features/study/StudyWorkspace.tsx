/**
 * Study page composition: context strip → path history → matrix + detail rail → lower dock.
 *
 * Visual tweaks usually belong in CSS, not here:
 *   styles/layout.css          chrome, Hands tiles, matrix shell
 *   styles/matrix-density.css  13×13 cell type
 *   styles/actions.css         Actions blocks in the detail rail
 *   styles/path-nav.css        action-history path strip
 * Structure of the right rail: matrix/StudyDetailPanel.tsx (Actions + Hands).
 */
import { useEffect } from "react";
import { LowerDock } from "../analysis/LowerDock";
import { LockDrawer } from "../locks/LockDrawer";
import { ActionNavBar } from "../matrix/ActionNavBar";
import { MatrixDisplayControls } from "../matrix/MatrixDisplayControls";
import { OpponentRangePanel } from "../matrix/OpponentRangePanel";
import { RangeMatrix } from "../matrix/RangeMatrix";
import { StudyDetailPanel } from "../matrix/StudyDetailPanel";
import { StrategyEditDrawer } from "../strategy/StrategyEditDrawer";
import type { MatrixMode } from "../../domain/types";
import { useStudyStore } from "../../state/studyStore";
import { ActionHistory } from "./ActionHistory";
import { ContextStrip } from "./ContextStrip";

/** Keep EV + equity warm for every decision node without a manual Calculate click. */
function AlwaysOnNodeAnalysis() {
  const solutionId = useStudyStore((s) => s.solutionId);
  const currentNode = useStudyStore((s) => s.currentNode);
  const ensureNodeAnalysis = useStudyStore((s) => s.ensureNodeAnalysis);
  const nodeId = currentNode?.node_id;
  const kind = currentNode?.kind;
  useEffect(() => {
    if (!solutionId || !nodeId) {
      return;
    }
    if (kind === "chance" || kind === "terminal") {
      return;
    }
    void ensureNodeAnalysis();
  }, [solutionId, nodeId, kind, ensureNodeAnalysis]);
  return null;
}

const MODES: Array<{ id: MatrixMode; label: string }> = [
  { id: "strategy", label: "Strategy" },
  { id: "range", label: "Range" },
  { id: "ev", label: "EV" },
];

function MatrixModeToolbar() {
  const matrixMode = useStudyStore((s) => s.matrixMode);
  const setMatrixMode = useStudyStore((s) => s.setMatrixMode);
  const nodeValues = useStudyStore((s) => s.nodeValues);
  const currentNode = useStudyStore((s) => s.currentNode);
  const evReady = Boolean(nodeValues && !nodeValues.pending && !nodeValues.error);
  const evPending = Boolean(nodeValues?.pending);
  const strategyActive =
    matrixMode === "strategy" || matrixMode === "strategy-ev";

  return (
    <div className="matrix-toolbar" role="group" aria-label="Matrix mode">
      <div className="matrix-toolbar__modes">
        {MODES.map((mode) => {
          const pressed =
            mode.id === "strategy" ? strategyActive : matrixMode === mode.id;
          return (
            <button
              key={mode.id}
              type="button"
              className="mode-btn"
              aria-pressed={pressed}
              disabled={
                mode.id === "ev" &&
                currentNode?.kind != null &&
                currentNode.kind !== "decision"
              }
              title={
                mode.id === "ev" && !evReady
                  ? evPending
                    ? "Calculating action EVs…"
                    : nodeValues?.error
                      ? String(nodeValues.error)
                      : "Action EVs loading…"
                  : undefined
              }
              onClick={() => {
                setMatrixMode(mode.id);
              }}
            >
              {mode.label}
            </button>
          );
        })}
      </div>
      <ActionNavBar />
      <MatrixDisplayControls />
    </div>
  );
}

export function StudyWorkspace() {
  const dualRange = useStudyStore((s) => s.layout.dualRange);
  const lockDrawerOpen = useStudyStore((s) => s.lockDrawerOpen);
  const strategyEditDrawerOpen = useStudyStore((s) => s.strategyEditDrawerOpen);

  return (
    <div className="study-workspace">
      <AlwaysOnNodeAnalysis />
      <ContextStrip />
      <ActionHistory />
      <div className="study-main" data-nav="false">
        <section
          className="matrix-pane"
          data-dual={dualRange ? "true" : "false"}
          aria-label="Strategy matrix"
        >
          <MatrixModeToolbar />
          <div className="matrix-stage">
            {dualRange ? (
              <div className="matrix-dual">
                <RangeMatrix />
                <OpponentRangePanel />
              </div>
            ) : (
              <RangeMatrix />
            )}
            <StudyDetailPanel />
          </div>
        </section>
      </div>
      <LowerDock />
      {lockDrawerOpen ? <LockDrawer /> : null}
      {strategyEditDrawerOpen ? <StrategyEditDrawer /> : null}
    </div>
  );
}
