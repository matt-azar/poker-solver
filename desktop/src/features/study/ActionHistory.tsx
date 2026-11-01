import { useCallback, useMemo, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { mapActionColors } from "../../domain/actionColors";
import {
  actorLabel,
  formatChoiceFrequency,
  lineCrumbs,
  nextChoicesFromNode,
} from "../../domain/actionHistory";
import { useStudyStore } from "../../state/studyStore";

export function ActionHistory() {
  const currentNode = useStudyStore((s) => s.currentNode);
  const status = useStudyStore((s) => s.status);
  const layout = useStudyStore((s) => s.layout);
  const setLayout = useStudyStore((s) => s.setLayout);
  const navigateTo = useStudyStore((s) => s.navigateTo);
  const followAction = useStudyStore((s) => s.followAction);

  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      event.preventDefault();
      dragRef.current = { startY: event.clientY, startH: layout.historyHeight };
      const onMove = (ev: PointerEvent) => {
        if (!dragRef.current) {
          return;
        }
        const maxHistory =
          typeof window === "undefined"
            ? 280
            : Math.max(96, Math.floor(window.innerHeight * 0.35));
        const next = Math.min(
          maxHistory,
          Math.max(56, dragRef.current.startH + (ev.clientY - dragRef.current.startY)),
        );
        setLayout({ historyHeight: next });
      };
      const onUp = () => {
        dragRef.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [layout.historyHeight, setLayout],
  );

  const rootId = status?.root_node_id || "p0.t-1.r-1";
  const crumbs = useMemo(
    () => lineCrumbs(currentNode?.line, rootId),
    [currentNode?.line, rootId],
  );
  const choices = useMemo(() => nextChoicesFromNode(currentNode), [currentNode]);
  const colors = useMemo(
    () => mapActionColors(currentNode?.actions ?? []),
    [currentNode?.actions],
  );
  const actor = actorLabel(currentNode?.to_act, currentNode?.player ?? null);
  const chance = currentNode?.kind === "chance";
  const terminal = currentNode?.kind === "terminal";

  return (
    <section className="action-history" style={{ height: layout.historyHeight }}>
      <div className="action-history__row action-history__line">
        <span className="action-history__label">Line</span>
        {currentNode ? (
          <nav className="action-history__crumbs" aria-label="Action line">
            {crumbs.map((crumb, index) => {
              const last = index === crumbs.length - 1;
              const clickable = Boolean(crumb.nodeId);
              return (
                <span key={`${crumb.label}-${index}`} className="action-history__crumb-wrap">
                  {index > 0 ? (
                    <span className="action-history__sep" aria-hidden>
                      ›
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="action-history__crumb"
                    data-current={last ? "true" : "false"}
                    disabled={!clickable}
                    title={clickable ? `Go to ${crumb.label}` : crumb.label}
                    onClick={() => {
                      if (crumb.nodeId) {
                        void navigateTo(crumb.nodeId);
                      }
                    }}
                  >
                    {crumb.label}
                  </button>
                </span>
              );
            })}
          </nav>
        ) : (
          <span className="empty-hint">Solve a spot to browse the tree.</span>
        )}
        {currentNode ? (
          <span className="action-history__actor tabular">
            {chance ? "Deal" : terminal ? "Showdown" : `${actor} to act`}
          </span>
        ) : null}
      </div>

      <div className="action-history__row action-history__next">
        <span className="action-history__label">{chance ? "Cards" : "Next"}</span>
        <div className="action-history__choices" role="group" aria-label="Next actions">
          {!currentNode ? (
            <span className="empty-hint">—</span>
          ) : terminal ? (
            <span className="muted">Terminal node</span>
          ) : choices.length === 0 ? (
            <span className="muted">No branches</span>
          ) : (
            choices.map((choice, index) => {
              const freq = formatChoiceFrequency(choice.frequency);
              const color =
                choice.kind === "action" ? colors.byIndex[index] : undefined;
              return (
                <button
                  key={choice.key}
                  type="button"
                  className="history-choice"
                  data-kind={choice.kind}
                  disabled={!choice.nodeId}
                  style={
                    color
                      ? { ["--choice-swatch" as string]: color }
                      : undefined
                  }
                  onClick={() => {
                    if (choice.nodeId) {
                      void followAction(choice.nodeId);
                    }
                  }}
                >
                  {choice.kind === "action" ? (
                    <span className="history-choice__swatch" aria-hidden />
                  ) : null}
                  <span className="history-choice__label">{choice.label}</span>
                  {freq ? (
                    <span className="history-choice__freq tabular">{freq}</span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      </div>

      <div
        className="resize-handle"
        onPointerDown={onPointerDown}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize action history"
      />
    </section>
  );
}
