import { LowerDock } from "../analysis/LowerDock";
import { LockDrawer } from "../locks/LockDrawer";
import { MatrixDisplayControls } from "../matrix/MatrixDisplayControls";
import { OpponentRangePanel } from "../matrix/OpponentRangePanel";
import { RangeMatrix } from "../matrix/RangeMatrix";
import { StudyDetailPanel } from "../matrix/StudyDetailPanel";
import { StrategyEditDrawer } from "../strategy/StrategyEditDrawer";
import type { MatrixMode } from "../../domain/types";
import { useStudyStore } from "../../state/studyStore";
import { ActionHistory } from "./ActionHistory";
import { ContextStrip } from "./ContextStrip";

const MODES: Array<{ id: MatrixMode; label: string }> = [
  { id: "strategy", label: "Strategy" },
  { id: "range", label: "Range" },
  { id: "ev", label: "EV" },
];

function MatrixModeToolbar() {
  const matrixMode = useStudyStore((s) => s.matrixMode);
  const setMatrixMode = useStudyStore((s) => s.setMatrixMode);
  const nodeValues = useStudyStore((s) => s.nodeValues);
  const evReady = Boolean(nodeValues && !nodeValues.pending);
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
              disabled={mode.id === "ev" && !evReady}
              onClick={() => setMatrixMode(mode.id)}
            >
              {mode.label}
            </button>
          );
        })}
      </div>
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
