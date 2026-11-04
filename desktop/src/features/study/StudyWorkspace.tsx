import { LowerDock } from "../analysis/LowerDock";
import { LockDrawer } from "../locks/LockDrawer";
import { ActionSummary } from "../matrix/ActionSummary";
import { ComboInspector } from "../matrix/ComboInspector";
import { OpponentRangePanel } from "../matrix/OpponentRangePanel";
import { RangeMatrix } from "../matrix/RangeMatrix";
import { StrategyEditDrawer } from "../strategy/StrategyEditDrawer";
import { useStudyStore } from "../../state/studyStore";
import { ActionHistory } from "./ActionHistory";
import { ContextStrip } from "./ContextStrip";

export function StudyWorkspace() {
  const dualRange = useStudyStore((s) => s.layout.dualRange);
  const inspectorWidth = useStudyStore((s) => s.layout.inspectorWidth);
  const lockDrawerOpen = useStudyStore((s) => s.lockDrawerOpen);
  const strategyEditDrawerOpen = useStudyStore((s) => s.strategyEditDrawerOpen);

  return (
    <div className="study-workspace">
      <ContextStrip />
      <ActionHistory />
      <div
        className="study-main"
        data-nav="false"
        style={{ ["--inspector-w" as string]: `${inspectorWidth}px` }}
      >
        <section
          className="matrix-pane"
          data-dual={dualRange ? "true" : "false"}
          aria-label="Strategy matrix"
        >
          <ActionSummary />
          <div className="matrix-stage">
            {dualRange ? (
              <div className="matrix-dual">
                <RangeMatrix />
                <OpponentRangePanel />
              </div>
            ) : (
              <RangeMatrix />
            )}
            <ComboInspector />
          </div>
        </section>
      </div>
      <LowerDock />
      {lockDrawerOpen ? <LockDrawer /> : null}
      {strategyEditDrawerOpen ? <StrategyEditDrawer /> : null}
    </div>
  );
}
