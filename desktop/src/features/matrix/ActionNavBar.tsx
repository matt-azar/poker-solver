import { useMemo } from "react";
import { actionSizePotBasis } from "../../domain/actionHistory";
import { mapActionColors } from "../../domain/actionColors";
import {
  formatActionDisplay,
  formatActionTooltip,
} from "../../domain/betSizes";
import { useSettingsStore } from "../../state/settingsStore";
import { useStudyStore } from "../../state/studyStore";
import { childIdAt } from "./childIdAt";
import "../../styles/actions.css";

/** Compact action navigation chips for the matrix toolbar (above the grid). */
export function ActionNavBar() {
  const currentNode = useStudyStore((s) => s.currentNode);
  const status = useStudyStore((s) => s.status);
  const draft = useStudyStore((s) => s.draft);
  const followAction = useStudyStore((s) => s.followAction);
  const betSizeDisplay = useSettingsStore((s) => s.settings.betSizeDisplay);

  const actions = currentNode?.actions;
  const pot = actionSizePotBasis(
    currentNode,
    Number(status?.pot ?? draft.pot ?? 0),
  );
  const toCall = Number(currentNode?.to_call ?? 0);
  const displayOpts = useMemo(() => ({ toCall }), [toCall]);

  const colors = useMemo(
    () => mapActionColors(actions ?? []),
    [actions],
  );

  if (!actions?.length) {
    return null;
  }

  return (
    <div className="action-nav" role="group" aria-label="Action navigation">
      {actions.map((label, index) => {
        const display = formatActionDisplay(
          label,
          pot,
          betSizeDisplay,
          displayOpts,
        );
        const childId = childIdAt(currentNode?.children, index);
        const disabled = !childId;
        return (
          <button
            key={`${label}-${index}`}
            type="button"
            className="action-nav__btn"
            disabled={disabled}
            title={
              disabled
                ? "No child node"
                : `Open ${formatActionTooltip(label, pot, betSizeDisplay, displayOpts)}`
            }
            aria-label={`Open ${display.primary}`}
            style={{ ["--action-color" as string]: colors.byIndex[index] }}
            onClick={() => {
              if (childId) {
                void followAction(childId);
              }
            }}
          >
            <span className="action-nav__swatch" aria-hidden />
            <span className="action-nav__label">{display.primary}</span>
          </button>
        );
      })}
    </div>
  );
}
