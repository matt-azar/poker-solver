import { usePhoneDemoLayout } from "../../demo/phoneLayout";
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
  return (
    <aside className="study-detail-panel" aria-label="Study detail">
      <ActionSummary />
      {phoneDemo ? null : <ComboInspector />}
    </aside>
  );
}
