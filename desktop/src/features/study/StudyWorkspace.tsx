import { LowerDock } from "../analysis/LowerDock";
import { ActionSummary } from "../matrix/ActionSummary";
import { ComboInspector } from "../matrix/ComboInspector";
import { RangeMatrix } from "../matrix/RangeMatrix";
import { NodeNavigator } from "../tree/NodeNavigator";
import { useStudyStore } from "../../state/studyStore";
import { ActionHistory } from "./ActionHistory";
import { ContextStrip } from "./ContextStrip";
import { SolveControls } from "./SolveControls";

export function StudyWorkspace() {
  const leftNav = useStudyStore((s) => s.layout.leftNav);
  const lowerDock = useStudyStore((s) => s.layout.lowerDock);
  const inspectorWidth = useStudyStore((s) => s.layout.inspectorWidth);

  return (
    <div className="study-workspace">
      <div className="study-tabs" role="tablist" aria-label="Study documents">
        <button type="button" className="study-tab" role="tab" aria-selected>
          Spot 1
        </button>
        <div className="study-tabs__controls">
          <SolveControls />
        </div>
      </div>
      <ContextStrip />
      <ActionHistory />
      <div
        className="study-main"
        data-nav={leftNav ? "true" : "false"}
        style={{ ["--inspector-w" as string]: `${inspectorWidth}px` }}
      >
        {leftNav ? <NodeNavigator /> : null}
        <section className="matrix-pane" aria-label="Strategy matrix">
          <ActionSummary />
          <RangeMatrix />
        </section>
        <ComboInspector />
      </div>
      {lowerDock ? <LowerDock /> : null}
    </div>
  );
}
