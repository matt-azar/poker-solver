import { LowerDock } from "../analysis/LowerDock";
import { LockDrawer } from "../locks/LockDrawer";
import { ActionSummary } from "../matrix/ActionSummary";
import { ComboInspector } from "../matrix/ComboInspector";
import { OpponentRangePanel } from "../matrix/OpponentRangePanel";
import { RangeMatrix } from "../matrix/RangeMatrix";
import { StrategyEditDrawer } from "../strategy/StrategyEditDrawer";
import { NodeNavigator } from "../tree/NodeNavigator";
import { useStudyStore } from "../../state/studyStore";
import { ActionHistory } from "./ActionHistory";
import { ContextStrip } from "./ContextStrip";

export function StudyWorkspace() {
  const leftNav = useStudyStore((s) => s.layout.leftNav);
  const lowerDock = useStudyStore((s) => s.layout.lowerDock);
  const dualRange = useStudyStore((s) => s.layout.dualRange);
  const inspectorWidth = useStudyStore((s) => s.layout.inspectorWidth);
  const lockDrawerOpen = useStudyStore((s) => s.lockDrawerOpen);
  const strategyEditDrawerOpen = useStudyStore((s) => s.strategyEditDrawerOpen);

  return (
    <div className="study-workspace">
      <div className="study-tabs" role="tablist" aria-label="Study documents">
        <button type="button" className="study-tab" role="tab" aria-selected>
          Spot 1
        </button>
      </div>
      <ContextStrip />
      <ActionHistory />
      <div
        className="study-main"
        data-nav={leftNav ? "true" : "false"}
        style={{ ["--inspector-w" as string]: `${inspectorWidth}px` }}
      >
        {leftNav ? <NodeNavigator /> : null}
        <section
          className="matrix-pane"
          data-dual={dualRange ? "true" : "false"}
          aria-label="Strategy matrix"
        >
          <ActionSummary />
          <div className={dualRange ? "matrix-dual" : undefined}>
            <RangeMatrix />
            {dualRange ? <OpponentRangePanel /> : null}
          </div>
        </section>
        <ComboInspector />
      </div>
      {lowerDock ? <LowerDock /> : null}
      {lockDrawerOpen ? <LockDrawer /> : null}
      {strategyEditDrawerOpen ? <StrategyEditDrawer /> : null}
    </div>
  );
}
