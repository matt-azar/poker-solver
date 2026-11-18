import { useMemo, useState } from "react";
import {
  studyIpcFeatureAvailable,
  studyIpcUnavailableReason,
} from "../../engine/ipcCapabilities";
import { mapActionColors } from "../../domain/actionColors";
import {
  comboProbsRowsForHands,
  formatProbPct,
  isHandLocked,
  lockAffectedComboCount,
  lockDraftIsDirty,
  lockForNode,
  normalizeProbs,
  weightedStrategyMix,
} from "../../domain/locks";
import { comboKey, expectedComboSlots } from "../../domain/matrixDisplay";
import { buildStrategyPaintSegments } from "../../domain/strategyPaint";
import { RANKS } from "../../domain/types";
import { useStudyStore } from "../../state/studyStore";
import { StrategyPaintBars } from "../matrix/StrategyPaintBars";
import {
  LockPaintPanel,
  nodeIndicesForCell,
  type LockHighlightFilter,
} from "./LockPaintPanel";
import "../../styles/locks.css";

function playerLabel(player: number | null | undefined, toAct?: string | null): string {
  if (toAct) {
    return toAct;
  }
  if (player === 0) {
    return "OOP";
  }
  if (player === 1) {
    return "IP";
  }
  return "—";
}

function formatBoard(board: string[] | string | null | undefined): string {
  if (!board) {
    return "—";
  }
  if (typeof board === "string") {
    return board.trim() || "—";
  }
  return board.filter(Boolean).join(" ") || "—";
}

function StrategyBar({
  label,
  mix,
  actions,
  colors,
}: {
  label: string;
  mix: number[] | null;
  actions: string[];
  colors: string[];
}) {
  const segments = useMemo(
    () => buildStrategyPaintSegments(actions, mix, colors),
    [actions, mix, colors],
  );
  return (
    <div className="node-lock-bar" aria-label={label}>
      <div className="node-lock-bar__label muted">{label}</div>
      {mix && actions.length > 0 ? (
        <>
          <StrategyPaintBars
            segments={segments}
            className="node-lock-bar__track"
            segClassName="node-lock-bar__seg"
          />
          <div className="node-lock-bar__legend tabular">
            {segments
              .map((seg) => `${seg.label} ${formatProbPct(seg.weight)}`)
              .join(" · ")}
          </div>
        </>
      ) : (
        <p className="empty-hint">No strategy mass.</p>
      )}
    </div>
  );
}

/**
 * Dedicated Pio-style Node Locking workspace.
 * Full-screen modal: strategy-colored 13×13 paint grid, frequency sliders,
 * overall/selected strategy bars, and Apply / Discard / Apply and re-solve.
 */
export function LockDrawer() {
  const open = useStudyStore((s) => s.lockDrawerOpen);
  const setLockDrawerOpen = useStudyStore((s) => s.setLockDrawerOpen);
  const currentNode = useStudyStore((s) => s.currentNode);
  const locks = useStudyStore((s) => s.locks);
  const lockDraft = useStudyStore((s) => s.lockDraft);
  const lockDraftBaseline = useStudyStore((s) => s.lockDraftBaseline);
  const lockScope = useStudyStore((s) => s.lockScope);
  const setLockScope = useStudyStore((s) => s.setLockScope);
  const setLockKind = useStudyStore((s) => s.setLockKind);
  const setLockProbLinked = useStudyStore((s) => s.setLockProbLinked);
  const seedLockFromStrategy = useStudyStore((s) => s.seedLockFromStrategy);
  const discardLockDraft = useStudyStore((s) => s.discardLockDraft);
  const clearLockSelection = useStudyStore((s) => s.clearLockSelection);
  const selectAllCombosForLock = useStudyStore((s) => s.selectAllCombosForLock);
  const applyLock = useStudyStore((s) => s.applyLock);
  const applyLockAndResolve = useStudyStore((s) => s.applyLockAndResolve);
  const lockAllHands = useStudyStore((s) => s.lockAllHands);
  const unlockHands = useStudyStore((s) => s.unlockHands);
  const unlockNode = useStudyStore((s) => s.unlockNode);
  const unlockLine = useStudyStore((s) => s.unlockLine);
  const clearAllLocks = useStudyStore((s) => s.clearAllLocks);
  const resolveLocked = useStudyStore((s) => s.resolveLocked);
  const warmStart = useStudyStore((s) => s.warmStart);
  const setWarmStart = useStudyStore((s) => s.setWarmStart);
  const loadCompare = useStudyStore((s) => s.loadCompare);
  const baselineSolutionId = useStudyStore((s) => s.baselineSolutionId);
  const message = useStudyStore((s) => s.message);
  const phase = useStudyStore((s) => s.phase);
  const setStrategyEditDrawerOpen = useStudyStore(
    (s) => s.setStrategyEditDrawerOpen,
  );

  const [highlight, setHighlight] = useState<LockHighlightFilter>("all");
  const [focus, setFocus] = useState<{
    row: number;
    col: number;
    text: string;
  } | null>(null);
  /** Pio: checkbox beside slider — protected actions are not donors/recipients. */
  const [protectedActions, setProtectedActions] = useState<boolean[]>([]);
  const [commitBusy, setCommitBusy] = useState(false);

  const actions = currentNode?.actions ?? [];
  const combos = currentNode?.combos;
  const colors = useMemo(() => mapActionColors(actions), [actions]);
  const nodeLock = useMemo(
    () => (currentNode ? lockForNode(locks, currentNode.node_id) : null),
    [locks, currentNode],
  );

  const protectedFlags = useMemo(() => {
    if (protectedActions.length === actions.length) {
      return protectedActions;
    }
    return actions.map((_, index) => Boolean(protectedActions[index]));
  }, [protectedActions, actions]);

  const normalized = useMemo(() => normalizeProbs(lockDraft.probs), [lockDraft.probs]);
  const rawSum = normalized.sum;
  const dirty = lockDraftIsDirty(lockDraft, lockDraftBaseline);
  const affectedCount = lockAffectedComboCount(
    lockDraft,
    combos?.length ?? 0,
  );

  const allIndices = useMemo(
    () => (combos ? combos.map((_, index) => index) : []),
    [combos],
  );

  const overallMix = useMemo(
    () =>
      weightedStrategyMix(
        currentNode?.strategy ?? null,
        allIndices,
        actions.length,
        Array.isArray(currentNode?.marginal)
          ? (currentNode.marginal as number[])
          : null,
      ),
    [currentNode?.strategy, currentNode?.marginal, allIndices, actions.length],
  );

  const appliedMix = useMemo(() => {
    const baseline = lockDraftBaseline;
    if (!baseline) {
      return null;
    }
    const handIndices =
      baseline.kind === "full" && combos?.length
        ? combos.map((_, index) => index)
        : baseline.handIndices;
    const rows = comboProbsRowsForHands(
      baseline.comboProbsByHand,
      handIndices,
    );
    if (rows && actions.length > 0) {
      return weightedStrategyMix(
        rows,
        handIndices.map((_, index) => index),
        actions.length,
        null,
      );
    }
    const norm = normalizeProbs(baseline.probs);
    return norm.valid ? norm.probs : null;
  }, [lockDraftBaseline, combos, actions.length]);

  const draftMix = useMemo(() => {
    const handIndices =
      lockDraft.kind === "full" && combos?.length
        ? combos.map((_, index) => index)
        : lockDraft.handIndices;
    const rows = comboProbsRowsForHands(lockDraft.comboProbsByHand, handIndices);
    if (rows && actions.length > 0) {
      return weightedStrategyMix(
        rows,
        handIndices.map((_, index) => index),
        actions.length,
        null,
      );
    }
    if (!normalized.valid) {
      return null;
    }
    return normalized.probs;
  }, [
    lockDraft.comboProbsByHand,
    lockDraft.handIndices,
    lockDraft.kind,
    combos,
    actions.length,
    normalized,
  ]);

  const focusCombos = useMemo(() => {
    if (!focus || !currentNode) {
      return [] as Array<{ combo: string; label: string; index: number; locked: boolean }>;
    }
    const indices = nodeIndicesForCell(currentNode.combos, focus.row, focus.col);
    const slots = expectedComboSlots(focus.row, focus.col, RANKS);
    const byKey = new Map(
      (currentNode.combos ?? []).map((combo, index) => [comboKey(combo), index] as const),
    );
    return slots
      .map((slot) => {
        const index = byKey.get(comboKey(slot.combo));
        if (index == null || !indices.includes(index)) {
          return null;
        }
        return {
          combo: slot.combo,
          label: slot.label,
          index,
          locked: isHandLocked(nodeLock, index),
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry != null);
  }, [focus, currentNode, nodeLock]);

  const busy = phase === "solving" || phase === "building" || commitBusy;
  const canApply =
    Boolean(currentNode && currentNode.kind === "decision") &&
    normalized.valid &&
    (lockDraft.kind === "full" || lockDraft.handIndices.length > 0);

  const onDiscard = () => {
    discardLockDraft();
  };

  const onCancel = () => {
    setLockDrawerOpen(false);
  };

  const onApply = async () => {
    setCommitBusy(true);
    try {
      await applyLock(lockScope);
    } finally {
      setCommitBusy(false);
    }
  };

  const onApplyAndResolve = async () => {
    setCommitBusy(true);
    try {
      await applyLockAndResolve(lockScope);
    } finally {
      setCommitBusy(false);
    }
  };

  if (!open) {
    return null;
  }

  const board = formatBoard(currentNode?.board);
  const line =
    typeof currentNode?.line === "string" && currentNode.line.trim()
      ? currentNode.line
      : currentNode?.node_id ?? "—";

  return (
    <div className="node-lock-overlay" role="presentation">
      <div
        className="node-lock-workspace"
        role="dialog"
        aria-modal="true"
        aria-label="Node locking"
      >
        <header className="node-lock-workspace__header">
          <div>
            <h2 className="panel-title">Node Locking</h2>
            <p className="node-lock-workspace__node muted">
              {currentNode ? (
                <>
                  <span className="node-lock-context">
                    <span className="node-lock-context__label">Board</span>{" "}
                    <span className="tabular">{board}</span>
                  </span>
                  <span className="node-lock-context">
                    <span className="node-lock-context__label">Line</span> {line}
                  </span>
                  <span className="node-lock-context">
                    <span className="node-lock-context__label">Actor</span>{" "}
                    {playerLabel(currentNode.player, currentNode.to_act)}
                  </span>
                </>
              ) : (
                "No node loaded"
              )}
            </p>
            <p className="node-lock-workspace__note muted">
              Re-solve constraint — not a session strategy edit.
            </p>
          </div>
          <div className="node-lock-workspace__header-actions">
            <button
              type="button"
              className="toolbar-btn"
              onClick={onCancel}
              title="Discard unapplied draft and close"
            >
              Cancel
            </button>
          </div>
        </header>

        <div className="node-lock-workspace__body">
          <section className="node-lock-workspace__grid" aria-label="Range selection">
            <div className="node-lock-toolbar">
              <div className="lock-kind-toggle" role="group" aria-label="Lock kind">
                <button
                  type="button"
                  className="toolbar-btn"
                  data-active={lockDraft.kind === "selected" ? "true" : "false"}
                  onClick={() => setLockKind("selected")}
                >
                  Selected combos
                </button>
                <button
                  type="button"
                  className="toolbar-btn"
                  data-active={lockDraft.kind === "full" ? "true" : "false"}
                  onClick={() => setLockKind("full")}
                >
                  Full node
                </button>
              </div>
              <div className="lock-kind-toggle" role="group" aria-label="Lock scope">
                <button
                  type="button"
                  className="toolbar-btn"
                  data-active={lockScope === "node" ? "true" : "false"}
                  onClick={() => setLockScope("node")}
                >
                  This board
                </button>
                <button
                  type="button"
                  className="toolbar-btn"
                  data-active={lockScope === "line" ? "true" : "false"}
                  onClick={() => setLockScope("line")}
                >
                  All runouts
                </button>
              </div>
              <div className="lock-kind-toggle" role="group" aria-label="Highlight">
                {(
                  [
                    ["all", "All"],
                    ["selected", "Selected"],
                    ["locked", "Locked"],
                    ["unlocked", "Unlocked"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className="toolbar-btn"
                    data-active={highlight === id ? "true" : "false"}
                    onClick={() => setHighlight(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <span className="muted tabular">
                {lockDraft.kind === "full"
                  ? `Full · ${combos?.length ?? 0} hands`
                  : `${lockDraft.handIndices.length} selected`}
                {dirty ? " · draft" : ""}
              </span>
            </div>
            <LockPaintPanel highlight={highlight} onFocusChange={setFocus} />
            <div className="node-lock-focus" aria-label="Focused hand class">
              <div className="lock-drawer__section-title">
                {focus ? focus.text : ""}
              </div>
              {focusCombos.length === 0 ? (
                focus ? (
                  <p className="empty-hint">No node combos in this class.</p>
                ) : null
              ) : (
                <ul className="lock-hand-list lock-hand-list--compact">
                  {focusCombos.map((entry) => (
                    <li
                      key={entry.combo}
                      className="lock-hand-row"
                      data-locked={entry.locked ? "true" : "false"}
                      data-in-draft={
                        lockDraft.kind === "full" ||
                        lockDraft.handIndices.includes(entry.index)
                          ? "true"
                          : "false"
                      }
                    >
                      <span className="lock-hand-row__mark" aria-hidden>
                        {entry.label}
                      </span>
                      <code>{entry.combo}</code>
                      <span className="muted tabular">#{entry.index}</span>
                      <span className="lock-hand-row__badge">
                        {entry.locked ? "locked" : "free"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <aside className="node-lock-workspace__rail" aria-label="Strategy and locks">
            <StrategyBar
              label="Overall range"
              mix={overallMix}
              actions={actions}
              colors={colors.byIndex}
            />
            <StrategyBar
              label="Applied frequencies"
              mix={appliedMix}
              actions={actions}
              colors={colors.byIndex}
            />
            <StrategyBar
              label="Proposed frequencies"
              mix={draftMix}
              actions={actions}
              colors={colors.byIndex}
            />

            <section className="lock-drawer__section" aria-label="Probability row">
              <div className="lock-drawer__section-title">Action frequencies</div>
              {actions.length === 0 ? (
                <p className="empty-hint">No actions at this node.</p>
              ) : (
                <div className="lock-prob-grid">
                  {actions.map((label, index) => {
                    const value = Number.isFinite(lockDraft.probs[index])
                      ? lockDraft.probs[index]!
                      : 0;
                    const isProtected = Boolean(protectedFlags[index]);
                    return (
                      <div
                        key={`${label}-${index}`}
                        className="lock-prob-row lock-prob-row--slider"
                      >
                        <label className="lock-prob-protect">
                          <input
                            type="checkbox"
                            checked={isProtected}
                            aria-label={`Protect ${label}`}
                            onChange={(event) => {
                              setProtectedActions((prev) => {
                                const next = actions.map((_, actionIndex) =>
                                  Boolean(prev[actionIndex]),
                                );
                                next[index] = event.target.checked;
                                return next;
                              });
                            }}
                          />
                          <span className="lock-prob-row__label">{label}</span>
                        </label>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.01}
                          className="lock-prob-slider"
                          value={value}
                          aria-label={`${label} frequency`}
                          onChange={(event) => {
                            setLockProbLinked(index, Number(event.target.value), {
                              protectedActions: protectedFlags,
                            });
                          }}
                        />
                        <input
                          type="number"
                          min={0}
                          max={1}
                          step={0.01}
                          className="lock-prob-input tabular"
                          value={value}
                          aria-label={`${label} frequency value`}
                          onChange={(event) => {
                            const next = Number(event.target.value);
                            setLockProbLinked(
                              index,
                              Number.isFinite(next) ? next : 0,
                              { protectedActions: protectedFlags },
                            );
                          }}
                        />
                        <span className="muted tabular">{formatProbPct(value)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="lock-prob-sum">
                <span className="muted">Sum</span>
                <strong className="tabular">{rawSum.toFixed(4)}</strong>
                {rawSum === 0 && actions.length > 0 ? (
                  <span className="lock-prob-sum__note">
                    invalid — use Unlock, not all-zero
                  </span>
                ) : null}
              </div>
            </section>

            <section
              className="lock-drawer__section lock-drawer__commit"
              aria-label="Apply lock"
            >
              <div className="lock-drawer__section-title">
                Commit{" "}
                <span className="muted tabular">
                  ({affectedCount} combo{affectedCount === 1 ? "" : "s"} ·{" "}
                  {lockScope === "line" ? "all runouts" : "this board"})
                </span>
              </div>
              <div className="lock-drawer__actions">
                <button
                  type="button"
                  className="toolbar-btn primary"
                  disabled={!canApply || busy}
                  onClick={() => void onApply()}
                  title="Apply the draft lock constraint"
                >
                  Apply lock
                </button>
                <button
                  type="button"
                  className="toolbar-btn primary"
                  disabled={
                    !canApply ||
                    busy ||
                    !studyIpcFeatureAvailable("resolveLocked")
                  }
                  onClick={() => void onApplyAndResolve()}
                  title="Apply the draft, then resolve locked"
                >
                  Apply and re-solve
                </button>
                <button
                  type="button"
                  className="toolbar-btn"
                  disabled={!dirty || busy}
                  onClick={onDiscard}
                  title="Restore the last applied lock frequencies"
                >
                  Discard changes
                </button>
              </div>
            </section>

            <section
              className="lock-drawer__section lock-drawer__actions"
              aria-label="Selection actions"
            >
              <button
                type="button"
                className="toolbar-btn"
                onClick={() => seedLockFromStrategy()}
              >
                Seed from strategy
              </button>
              <button
                type="button"
                className="toolbar-btn"
                onClick={() => void unlockHands()}
                disabled={lockDraft.handIndices.length === 0 || busy}
                title="Takes effect immediately"
              >
                Unlock selected (now)
              </button>
              <button
                type="button"
                className="toolbar-btn"
                onClick={() => clearLockSelection()}
                disabled={lockDraft.handIndices.length === 0}
              >
                Clear selection
              </button>
              <button type="button" className="toolbar-btn" onClick={() => selectAllCombosForLock()}>
                Select all
              </button>
            </section>

            <section className="lock-drawer__section" aria-label="Node lock actions">
              <div className="lock-drawer__section-title">Node</div>
              <div className="lock-drawer__actions">
                <button
                  type="button"
                  className="toolbar-btn"
                  onClick={() => {
                    void lockAllHands(lockScope);
                  }}
                  disabled={!currentNode || currentNode.kind !== "decision" || busy}
                  title="Freeze every combo's current mix"
                >
                  Lock all hands
                </button>
                <button
                  type="button"
                  className="toolbar-btn"
                  onClick={() => void unlockNode()}
                  disabled={busy}
                  title="Takes effect immediately"
                >
                  Unlock node (now)
                </button>
                <button
                  type="button"
                  className="toolbar-btn"
                  onClick={() => void unlockLine()}
                  disabled={!currentNode || currentNode.kind !== "decision" || busy}
                  title="Takes effect immediately — clears line-wide runout locks"
                >
                  Unlock line (now)
                </button>
                <button
                  type="button"
                  className="toolbar-btn danger"
                  onClick={() => void clearAllLocks()}
                  disabled={busy}
                  title="Takes effect immediately"
                >
                  Clear all locks (now)
                </button>
              </div>
            </section>

            <section className="lock-drawer__section" aria-label="Resolve locked">
              <div className="lock-drawer__section-title">Resolve</div>
              {!studyIpcFeatureAvailable("resolveLocked") ? (
                <p className="empty-hint" role="status">
                  {studyIpcUnavailableReason("resolveLocked")}
                </p>
              ) : null}
              <label className="lock-warm-start">
                <input
                  type="checkbox"
                  checked={warmStart}
                  disabled={!studyIpcFeatureAvailable("resolveLocked")}
                  onChange={(event) => setWarmStart(event.target.checked)}
                />
                <span>Warm-start from current strategy</span>
              </label>
              <div className="lock-drawer__actions">
                <button
                  type="button"
                  className="toolbar-btn"
                  disabled={
                    busy ||
                    !currentNode ||
                    !studyIpcFeatureAvailable("resolveLocked")
                  }
                  title={
                    !studyIpcFeatureAvailable("resolveLocked")
                      ? studyIpcUnavailableReason("resolveLocked")
                      : dirty
                        ? "Applies the draft lock first, then resolves"
                        : undefined
                  }
                  onClick={() => void resolveLocked()}
                >
                  Resolve locked
                </button>
                <button
                  type="button"
                  className="toolbar-btn"
                  disabled={
                    !studyIpcFeatureAvailable("compare") || !baselineSolutionId
                  }
                  onClick={() => void loadCompare()}
                  title={
                    !studyIpcFeatureAvailable("compare")
                      ? studyIpcUnavailableReason("compare")
                      : baselineSolutionId
                        ? `Baseline ${baselineSolutionId}`
                        : "Resolve locked first to create a baseline"
                  }
                >
                  Compare to baseline
                </button>
              </div>
            </section>

            <section className="lock-drawer__section" aria-label="Session strategy edit">
              <div className="lock-drawer__section-title">Session strategy edit</div>
              <p className="empty-hint">
                Free-form stored-strategy edits without a re-solve constraint.
              </p>
              <button
                type="button"
                className="toolbar-btn"
                disabled={!studyIpcFeatureAvailable("strategyEdits")}
                onClick={() => {
                  setLockDrawerOpen(false);
                  setStrategyEditDrawerOpen(true);
                }}
              >
                Open session strategy edit
              </button>
            </section>

            <section className="lock-drawer__section" aria-label="Existing locks">
              <div className="lock-drawer__section-title">
                Locks on solution{" "}
                <span className="muted tabular">({locks.length})</span>
              </div>
              {locks.length === 0 ? (
                <p className="empty-hint">No locks on this solution.</p>
              ) : (
                <ul className="lock-record-list">
                  {locks.map((entry) => {
                    const atCurrent =
                      !!currentNode && nodeLock?.node_id === entry.node_id;
                    const handCount =
                      entry.kind === "full"
                        ? "all"
                        : String(entry.hand_indices?.length ?? 0);
                    const scopeLabel =
                      entry.scope === "line"
                        ? "all runouts"
                        : entry.scope === "node"
                          ? "this board"
                          : null;
                    return (
                      <li
                        key={`${entry.node_id}-${entry.kind}-${handCount}-${scopeLabel ?? ""}`}
                        className="lock-record-row"
                        data-current={atCurrent ? "true" : "false"}
                      >
                        <code>{entry.node_id}</code>
                        {scopeLabel ? <span>{scopeLabel}</span> : null}
                        <span>{entry.kind}</span>
                        <span className="tabular muted">{handCount} hands</span>
                        {atCurrent ? (
                          <span className="lock-hand-row__badge">here</span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {message ? <p className="lock-drawer__message muted">{message}</p> : null}
          </aside>
        </div>
      </div>
    </div>
  );
}
