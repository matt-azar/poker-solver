import { usePhoneDemoLayout } from "../../demo/phoneLayout";
import { useStudyStore } from "../../state/studyStore";
import { ActionSummary } from "./ActionSummary";
import { ComboInspector } from "./ComboInspector";

/**
 * GTO-style Study right rail: node Actions on top, hovered/selected Hands below.
 * Pane chrome: layout.css .study-detail-panel.
 * Actions look: styles/actions.css. Hands tiles: layout.css .hands-combo*.
 * Phone public demo: Actions stay inline; Hands open in HandInspectSheet.
 */
export function StudyDetailPanel() {
  const phoneDemo = usePhoneDemoLayout();
  const inspectorWidth = useStudyStore((s) => s.layout.inspectorWidth);
  return (
    <aside
      className="study-detail-panel"
      aria-label="Study detail"
      style={
        phoneDemo
          ? undefined
          : {
              flex: `0 0 ${inspectorWidth}px`,
              width: inspectorWidth,
              minWidth: inspectorWidth,
              maxWidth: inspectorWidth,
            }
      }
    >
      <ActionSummary />
      {phoneDemo ? null : <ComboInspector />}
    </aside>
  );
}
