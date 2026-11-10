import { useMemo, useState } from "react";
import { mapActionColors } from "../../domain/actionColors";
import { orderActionIndicesByAggression } from "../../domain/actionOrder";
import {
  formatProbPct,
  isHandLocked,
  lockForNode,
  normalizeProbs,
  weightedStrategyMix,
} from "../../domain/locks";
import { comboKey, expectedComboSlots } from "../../domain/matrixDisplay";
import { RANKS } from "../../domain/types";
import { useStudyStore } from "../../state/studyStore";
import {
  LockPaintPanel,
  nodeIndicesForCell,
  type LockHighlightFilter,
} from "./LockPaintPanel";

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
  const order = useMemo(
    () => orderActionIndicesByAggression(actions),
    [actions],
  );
  return (
    <div className="node-lock-bar" aria-label={label}>
      <div className="node-lock-bar__label muted">{label}</div>
      {mix && actions.length > 0 ? (
        <>
          <div className="node-lock-bar__track">
            {order.map((index) => {
              const weight = mix[index] ?? 0;
              return weight > 0.001 ? (
                <span
                  key={`${actions[index]}-${index}`}
                  className="node-lock-bar__seg"
                  title={`${actions[index]} ${formatProbPct(weight)}`}
                  style={{
                    flexGrow: weight,
                    flexBasis: 0,
                    background: colors[index] || "#666",
                  }}
                />
              ) : null;
            })}
          </div>
          <div className="node-lock-bar__legend tabular">
            {order
              .map((index) => `${actions[index]} ${formatProbPct(mix[index] ?? 0)}`)
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
 * overall/selected strategy bars, and Save & Close.
 */
export function LockDrawer() {
  const open = useStudyStore((s) => s.lockDrawerOpen);
  const setLockDrawerOpen = useStudyStore((s) => s.setLockDrawerOpen);
  const currentNode = useStudyStore((s) => s.currentNode);
  const locks = useStudyStore((s) => s.locks);
  const lockDraft = useStudyStore((s) => s.lockDraft);
  const setLockKind = useStudyStore((s) => s.setLockKind);
  const setLockProbAt = useStudyStore((s) => s.setLockProbAt);
  const setLockProbLinked = useStudyStore((s) => s.setLockProbLinked);
  const seedLockFromStrategy = useStudyStore((s) => s.seedLockFromStrategy);
  const revertLockDraft = useStudyStore((s) => s.revertLockDraft);
  const clearLockSelection = useStudyStore((s) => s.clearLockSelection);
  const selectAllCombosForLock = useStudyStore((s) => s.selectAllCombosForLock);
  const applyLock = useStudyStore((s) => s.applyLock);
  const unlockHands = useStudyStore((s) => s.unlockHands);
  const unlockNode = useStudyStore((s) => s.unlockNode);
  const clearAllLocks = useStudyStore((s) => s.clearAllLocks);
  const resolveLocked = useStudyStore((s) => s.resolveLocked);
  const warmStart = useStudyStore((s) => s.warmStart);
  const setWarmStart = useStudyStore((s) => s.setWarmStart);
  const loadCompare = useStudyStore((s) => s.loadCompare);
  const baselineSolutionId = useStudyStore((s) => s.baselineSolutionId);
  const message = useStudyStore((s) => s.message);
  const phase = useStudyStore((s) => s.phase);

  const [highlight, setHighlight] = useState<LockHighlightFilter>("all");
  const [focus, setFocus] = useState<{
    row: number;
    col: number;
    text: string;
  } | null>(null);

  const actions = currentNode?.actions ?? [];
  const combos = currentNode?.combos;
  const colors = useMemo(() => mapActionColors(actions), [actions]);
  const nodeLock = useMemo(
    () => (currentNode ? lockForNode(locks, currentNode.node_id) : null),
    [locks, currentNode],
  );

  const normalized = useMemo(() => normalizeProbs(lockDraft.probs), [lockDraft.probs]);
  const rawSum = normalized.sum;

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

  const selectedMix = useMemo(() => {
    if (lockDraft.kind === "full") {
      return overallMix;
    }
    return weightedStrategyMix(
      currentNode?.strategy ?? null,
      lockDraft.handIndices,
      actions.length,
      Array.isArray(currentNode?.marginal)
        ? (currentNode.marginal as number[])
        : null,
    );
  }, [
    lockDraft.kind,
    lockDraft.handIndices,
    currentNode?.strategy,
    currentNode?.marginal,
    actions.length,
    overallMix,
  ]);

  const draftMix = useMemo(() => {
    if (!normalized.valid) {
      return null;
    }
    return normalized.probs;
  }, [normalized]);

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

  const busy = phase === "solving" || phase === "building";
  const canApply =
    Boolean(currentNode && currentNode.kind === "decision") &&
    normalized.valid &&
    (lockDraft.kind === "full" || lockDraft.handIndices.length > 0);

  const saveAndClose = async () => {
    const ok = await applyLock();
    if (ok) {
      setLockDrawerOpen(false);
    }
  };

  if (!open) {
    return null;
  }

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
                  <code>{currentNode.node_id}</code>
                  <span>
                    {" "}
                    · {playerLabel(currentNode.player, currentNode.to_act)}
                    {currentNode.kind ? ` · ${currentNode.kind}` : ""}
                  </span>
                </>
              ) : (
                "No node loaded"
              )}
            </p>
          </div>
          <div className="node-lock-workspace__header-actions">
            <button
              type="button"
              className="toolbar-btn"
              onClick={() => setLockDrawerOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="toolbar-btn primary"
              disabled={!canApply}
              onClick={() => void saveAndClose()}
              title="Apply the lock constraint and close"
            >
              Save &amp; Close
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
              </span>
            </div>
            <LockPaintPanel highlight={highlight} onFocusChange={setFocus} />
            <div className="node-lock-focus" aria-label="Focused hand class">
              <div className="lock-drawer__section-title">
                {focus ? focus.text : "Hover a hand class"}
              </div>
              {focusCombos.length === 0 ? (
                <p className="empty-hint">
                  {focus
                    ? "No node combos in this class."
                    : "Hover the grid to inspect suit combos."}
                </p>
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
              label="Selected range"
              mix={selectedMix}
              actions={actions}
              colors={colors.byIndex}
            />
            <StrategyBar
              label="Draft lock frequencies"
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
                    return (
                      <label key={`${label}-${index}`} className="lock-prob-row lock-prob-row--slider">
                        <span className="lock-prob-row__label">{label}</span>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.01}
                          className="lock-prob-slider"
                          value={value}
                          aria-label={`${label} frequency`}
                          onChange={(event) => {
                            setLockProbLinked(index, Number(event.target.value));
                          }}
                        />
                        <input
                          type="number"
                          min={0}
                          max={1}
                          step={0.01}
                          className="lock-prob-input tabular"
                          value={value}
                          onChange={(event) => {
                            const next = Number(event.target.value);
                            setLockProbAt(index, Number.isFinite(next) ? next : 0);
                          }}
                        />
                        <span className="muted tabular">{formatProbPct(value)}</span>
                      </label>
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
              <button type="button" className="toolbar-btn" onClick={() => revertLockDraft()}>
                Revert draft
              </button>
              <button
                type="button"
                className="toolbar-btn primary"
                onClick={() => void applyLock("node")}
                disabled={!canApply}
                title="Lock selected hands on this board only"
              >
                Lock selected
              </button>
              <button
                type="button"
                className="toolbar-btn"
                onClick={() => void applyLock("line")}
                disabled={!canApply}
                title="Lock selected hands on every runout of this betting line"
              >
                Lock selected on line
              </button>
              <button
                type="button"
                className="toolbar-btn"
                onClick={() => void unlockHands()}
                disabled={lockDraft.handIndices.length === 0}
              >
                Unlock selected
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
                    setLockKind("full");
                    void applyLock("node");
                  }}
                  disabled={!currentNode || currentNode.kind !== "decision" || !normalized.valid}
                  title="Lock only the selected board (this runout)"
                >
                  Lock all hands
                </button>
                <button
                  type="button"
                  className="toolbar-btn"
                  onClick={() => {
                    setLockKind("full");
                    void applyLock("line");
                  }}
                  disabled={!currentNode || currentNode.kind !== "decision" || !normalized.valid}
                  title="Lock this betting line on every runout (Pio lock_line)"
                >
                  Lock line across runouts
                </button>
                <button type="button" className="toolbar-btn" onClick={() => void unlockNode()}>
                  Unlock node
                </button>
                <button
                  type="button"
                  className="toolbar-btn danger"
                  onClick={() => void clearAllLocks()}
                >
                  Clear all locks
                </button>
              </div>
            </section>

            <section className="lock-drawer__section" aria-label="Resolve locked">
              <div className="lock-drawer__section-title">Resolve</div>
              <label className="lock-warm-start">
                <input
                  type="checkbox"
                  checked={warmStart}
                  onChange={(event) => setWarmStart(event.target.checked)}
                />
                <span>Warm-start from current strategy</span>
              </label>
              <div className="lock-drawer__actions">
                <button
                  type="button"
                  className="toolbar-btn primary"
                  disabled={busy || !currentNode}
                  onClick={() => void resolveLocked()}
                >
                  Resolve locked
                </button>
                <button
                  type="button"
                  className="toolbar-btn"
                  disabled={!baselineSolutionId}
                  onClick={() => void loadCompare()}
                  title={
                    baselineSolutionId
                      ? `Baseline ${baselineSolutionId}`
                      : "Resolve locked first to create a baseline"
                  }
                >
                  Compare to baseline
                </button>
              </div>
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
                        ? "line"
                        : entry.scope === "node"
                          ? "node"
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
