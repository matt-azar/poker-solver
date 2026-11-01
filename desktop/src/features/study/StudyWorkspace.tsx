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
  const dualRange = useStudyStore((s) => s.layout.dualRange);
  const inspectorWidth = useStudyStore((s) => s.layout.inspectorWidth);
  const currentNode = useStudyStore((s) => s.currentNode);
  const lockDrawerOpen = useStudyStore((s) => s.lockDrawerOpen);
  const strategyEditDrawerOpen = useStudyStore((s) => s.strategyEditDrawerOpen);
  const showNav = leftNav && Boolean(currentNode);

  return (
    <div className="study-workspace">
      <ContextStrip />
      <ActionHistory />
      <div
        className="study-main"
        data-nav={showNav ? "true" : "false"}
        style={{ ["--inspector-w" as string]: `${inspectorWidth}px` }}
      >
        {showNav ? <NodeNavigator /> : null}
        <section
          className="matrix-pane"
          data-dual={dualRange ? "true" : "false"}
          aria-label="Strategy matrix"
        >
          <ActionSummary />
          <div className={dualRange ? "matrix-dual" : "matrix-stage"}>
            <RangeMatrix />
            {dualRange ? <OpponentRangePanel /> : <ComboInspector />}
          </div>
        </section>
      </div>
      <LowerDock />
      {lockDrawerOpen ? <LockDrawer /> : null}
      {strategyEditDrawerOpen ? <StrategyEditDrawer /> : null}
    </div>
  );
}
