import { ActionSummary } from "./ActionSummary";
import { ComboInspector } from "./ComboInspector";

/**
 * GTO-style Study right rail: node Actions on top, hovered/selected Hands below.
 */
export function StudyDetailPanel() {
  return (
    <aside className="study-detail-panel" aria-label="Study detail">
      <ActionSummary />
      <ComboInspector />
    </aside>
  );
}
