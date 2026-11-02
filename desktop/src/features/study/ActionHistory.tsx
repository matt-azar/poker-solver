import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { mapActionColors } from "../../domain/actionColors";
import {
  actionSizePotBasis,
  formatChoiceFrequency,
  groupCrumbsByStreet,
  groupPathByStreet,
  isTerminalFold,
  nextChoicesFromNode,
  nodeStatusLabel,
  pathCrumbsFromTrail,
  streetLabel,
  type PathAlternative,
  type PathStep,
  type PathStreetGroup,
} from "../../domain/actionHistory";
import {
  formatActionDisplay,
  formatActionTooltip,
  formatFrequencyPct,
} from "../../domain/betSizes";
import { useSettingsStore } from "../../state/settingsStore";
import { useStudyStore } from "../../state/studyStore";
import "../../styles/path-nav.css";
import "../../styles/actions.css";
import { ActionBlock } from "../matrix/ActionBlock";

function suitOf(card: string): string {
  return card.slice(1, 2)?.toLowerCase() || "";
}

function stepsFromTrailOrCrumbs(
  trail: PathStep[],
  line: string | null | undefined,
  rootId: string,
  currentNodeId: string | undefined,
  pot: number,
  board: string[] | string | null | undefined,
  place: string | null | undefined,
): PathStreetGroup[] {
  if (
    trail.length > 0 &&
    (!currentNodeId || trail[trail.length - 1]?.nodeId === currentNodeId)
  ) {
    return groupPathByStreet(trail, board);
  }
  const crumbs = pathCrumbsFromTrail(trail, line, rootId, currentNodeId, pot);
  return groupCrumbsByStreet(crumbs, board, place);
}

export function ActionHistory() {
  const currentNode = useStudyStore((s) => s.currentNode);
  const status = useStudyStore((s) => s.status);
  const draft = useStudyStore((s) => s.draft);
  const pathTrail = useStudyStore((s) => s.pathTrail);
  const canNavBack = useStudyStore((s) => s.canNavBack);
  const canNavForward = useStudyStore((s) => s.canNavForward);
  const goNavBack = useStudyStore((s) => s.goNavBack);
  const goNavForward = useStudyStore((s) => s.goNavForward);
  const jumpTrailIndex = useStudyStore((s) => s.jumpTrailIndex);
  const takeTrailAlternative = useStudyStore((s) => s.takeTrailAlternative);
  const betSizeDisplay = useSettingsStore((s) => s.settings.betSizeDisplay);
  const layout = useStudyStore((s) => s.layout);
  const setLayout = useStudyStore((s) => s.setLayout);
  const followAction = useStudyStore((s) => s.followAction);

  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const [openAlts, setOpenAlts] = useState<number | null>(null);

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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      const alt = event.altKey;
      const meta = event.metaKey || event.ctrlKey;
      if ((alt || meta) && event.key === "ArrowLeft") {
        if (!canNavBack) {
          return;
        }
        event.preventDefault();
        void goNavBack();
        return;
      }
      if ((alt || meta) && event.key === "ArrowRight") {
        if (!canNavForward) {
          return;
        }
        event.preventDefault();
        void goNavForward();
        return;
      }
      if (!alt && !meta && !event.shiftKey && event.key === "[") {
        if (!canNavBack) {
          return;
        }
        event.preventDefault();
        void goNavBack();
        return;
      }
      if (!alt && !meta && !event.shiftKey && event.key === "]") {
        if (!canNavForward) {
          return;
        }
        event.preventDefault();
        void goNavForward();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canNavBack, canNavForward, goNavBack, goNavForward]);

  useEffect(() => {
    const onDoc = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) {
        return;
      }
      if (!event.target.closest(".path-nav__step-wrap")) {
        setOpenAlts(null);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const rootId = status?.root_node_id || "p0.t-1.r-1";
  const pot = actionSizePotBasis(
    currentNode,
    Number(status?.pot ?? draft.pot ?? 0),
  );
  const place =
    typeof currentNode?.place === "string" ? currentNode.place : null;

  const streetGroups = useMemo(
    () =>
      currentNode
        ? stepsFromTrailOrCrumbs(
            pathTrail,
            currentNode.line,
            rootId,
            currentNode.node_id,
            pot,
            currentNode.board,
            place,
          )
        : [],
    [currentNode, pathTrail, pot, rootId, place],
  );

  const choices = useMemo(() => nextChoicesFromNode(currentNode), [currentNode]);
  const colors = useMemo(
    () => mapActionColors(currentNode?.actions ?? []),
    [currentNode?.actions],
  );
  const dealNode = currentNode?.kind === "chance";
  const terminal = currentNode?.kind === "terminal";
  const statusLabel = nodeStatusLabel(currentNode);
  const terminalKind = terminal
    ? isTerminalFold(currentNode)
      ? "fold"
      : "showdown"
    : undefined;

  const renderedSteps = useMemo(() => {
    const rows: Array<{
      group: PathStreetGroup;
      groupIndex: number;
      step: PathStep;
      stepIndex: number;
      flatIndex: number;
      showStepSep: boolean;
      isCurrent: boolean;
    }> = [];
    let flatIndex = 0;
    const total = streetGroups.reduce((sum, group) => sum + group.steps.length, 0);
    streetGroups.forEach((group, groupIndex) => {
      group.steps.forEach((step, stepIndex) => {
        rows.push({
          group,
          groupIndex,
          step,
          stepIndex,
          flatIndex,
          showStepSep: stepIndex > 0,
          isCurrent: flatIndex === total - 1,
        });
        flatIndex += 1;
      });
    });
    return rows;
  }, [streetGroups]);

  const onStepClick = (flatIndex: number, step: PathStep, isCurrent: boolean) => {
    if (isCurrent || !step.nodeId) {
      return;
    }
    setOpenAlts(null);
    void jumpTrailIndex(flatIndex);
  };

  const onPickAlternative = (flatIndex: number, alternative: PathAlternative) => {
    setOpenAlts(null);
    void takeTrailAlternative(flatIndex, alternative);
  };

  return (
    <section
      className="path-nav action-history"
      data-empty={currentNode ? "false" : "true"}
      style={currentNode ? { height: layout.historyHeight } : undefined}
    >
      <div className="path-nav__row path-nav__line">
        <div className="path-nav__controls" role="group" aria-label="Path history">
          <button
            type="button"
            className="path-nav__btn"
            title="Back (Alt+← or [)"
            aria-label="Back"
            disabled={!canNavBack}
            onClick={() => void goNavBack()}
          >
            ←
          </button>
          <button
            type="button"
            className="path-nav__btn"
            title="Forward (Alt+→ or ])"
            aria-label="Forward"
            disabled={!canNavForward}
            onClick={() => void goNavForward()}
          >
            →
          </button>
        </div>
        <span className="path-nav__label">Path</span>
        {currentNode ? (
          <nav className="path-nav__streets" aria-label="Betting path by street">
            {streetGroups.map((group, groupIndex) => (
              <div
                key={`${group.street}-${groupIndex}`}
                className="path-nav__street"
                data-street={group.street}
              >
                <span className="path-nav__street-name">{streetLabel(group.street)}</span>
                {group.boardCards.length ? (
                  <span
                    className="path-nav__board"
                    aria-label={`${streetLabel(group.street)} board`}
                  >
                    {group.boardCards.map((card) => (
                      <span
                        key={`${group.street}-${card}`}
                        className="path-nav__card"
                        data-suit={suitOf(card)}
                        title={card}
                      >
                        {card}
                      </span>
                    ))}
                  </span>
                ) : null}
                <span className="path-nav__steps">
                  {renderedSteps
                    .filter((row) => row.groupIndex === groupIndex)
                    .map((row) => {
                      const { step, flatIndex, showStepSep, isCurrent } = row;
                      const alts =
                        step.alternatives?.filter((alt) => alt.nodeId) ?? [];
                      const clickable = Boolean(step.nodeId) && !isCurrent;
                      return (
                        <span
                          key={`${step.label}-${flatIndex}-${step.nodeId || flatIndex}`}
                          className="path-nav__step-wrap"
                        >
                          {showStepSep ? (
                            <span className="path-nav__sep" aria-hidden>
                              ›
                            </span>
                          ) : null}
                          {step.actor &&
                          step.kind !== "root" &&
                          step.kind !== "card" ? (
                            <span className="path-nav__actor" title="Acting player">
                              {step.actor}
                            </span>
                          ) : null}
                          <button
                            type="button"
                            className="path-nav__step"
                            data-current={isCurrent ? "true" : "false"}
                            data-kind={step.kind}
                            disabled={!clickable}
                            title={
                              step.nodeId
                                ? `${step.rawLabel || step.label} (${step.nodeId})`
                                : step.rawLabel || step.label
                            }
                            onClick={() => onStepClick(flatIndex, step, isCurrent)}
                          >
                            {step.label}
                          </button>
                          {alts.length && !isCurrent ? (
                            <>
                              <button
                                type="button"
                                className="path-nav__alt-toggle"
                                aria-label={`Alternatives to ${step.label}`}
                                aria-expanded={openAlts === flatIndex}
                                title="Change prior action"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setOpenAlts((prev) =>
                                    prev === flatIndex ? null : flatIndex,
                                  );
                                }}
                              >
                                ▾
                              </button>
                              {openAlts === flatIndex ? (
                                <div className="path-nav__alts" role="menu">
                                  {alts.map((alt) => (
                                    <button
                                      key={`${alt.nodeId}-${alt.label}`}
                                      type="button"
                                      className="path-nav__alt"
                                      role="menuitem"
                                      disabled={!alt.nodeId}
                                      onClick={() =>
                                        onPickAlternative(flatIndex, alt)
                                      }
                                    >
                                      {alt.label}
                                    </button>
                                  ))}
                                </div>
                              ) : null}
                            </>
                          ) : null}
                        </span>
                      );
                    })}
                </span>
              </div>
            ))}
          </nav>
        ) : (
          <span className="empty-hint">Solve a spot to browse the tree.</span>
        )}
        {currentNode ? (
          <span className="path-nav__status tabular" data-terminal={terminalKind}>
            {statusLabel}
          </span>
        ) : null}
      </div>

      <div className="path-nav__row path-nav__next">
        <span className="path-nav__label">{dealNode ? "Cards" : "Next"}</span>
        <div className="path-nav__choices" role="group" aria-label="Next actions">
          {!currentNode ? (
            <span className="empty-hint">—</span>
          ) : terminal ? (
            <span className="muted">
              {isTerminalFold(currentNode) ? "Fold terminal" : "Showdown terminal"}
            </span>
          ) : choices.length === 0 ? (
            <span className="muted">No branches</span>
          ) : (
            choices.map((choice, index) => {
              // Card / chance strip: keep compact history-choice buttons.
              if (choice.kind !== "action") {
                return (
                  <button
                    key={choice.key}
                    type="button"
                    className="path-nav-choice history-choice"
                    data-kind={choice.kind}
                    disabled={!choice.nodeId}
                    title={choice.nodeId ? choice.nodeId : choice.label}
                    onClick={() => {
                      if (choice.nodeId) {
                        void followAction(choice.nodeId);
                      }
                    }}
                  >
                    <span className="path-nav-choice__label">{choice.label}</span>
                  </button>
                );
              }
              const display = formatActionDisplay(choice.label, pot, betSizeDisplay);
              const freqText =
                formatFrequencyPct(choice.frequency) ??
                formatChoiceFrequency(choice.frequency);
              return (
                <ActionBlock
                  key={choice.key}
                  variant="follow"
                  primary={display.primary}
                  secondary={display.secondary}
                  frequency={choice.frequency}
                  frequencyText={freqText}
                  color={colors.byIndex[index]}
                  disabled={!choice.nodeId}
                  title={`${formatActionTooltip(choice.label, pot, betSizeDisplay)} · follow`}
                  aria-label={`Follow ${display.primary}${freqText ? `, ${freqText}` : ""}`}
                  onClick={() => {
                    if (choice.nodeId) {
                      void followAction(choice.nodeId);
                    }
                  }}
                />
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
