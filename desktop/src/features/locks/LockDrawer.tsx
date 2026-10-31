import { useMemo } from "react";
import {
  formatProbPct,
  isHandLocked,
  lockForNode,
  normalizeProbs,
} from "../../domain/locks";
import { useStudyStore } from "../../state/studyStore";

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

export function LockDrawer() {
  const open = useStudyStore((s) => s.lockDrawerOpen);
  const setLockDrawerOpen = useStudyStore((s) => s.setLockDrawerOpen);
  const currentNode = useStudyStore((s) => s.currentNode);
  const locks = useStudyStore((s) => s.locks);
  const lockDraft = useStudyStore((s) => s.lockDraft);
  const setLockKind = useStudyStore((s) => s.setLockKind);
  const setLockProbAt = useStudyStore((s) => s.setLockProbAt);
  const toggleLockHand = useStudyStore((s) => s.toggleLockHand);
  const seedLockFromStrategy = useStudyStore((s) => s.seedLockFromStrategy);
  const revertLockDraft = useStudyStore((s) => s.revertLockDraft);
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

  const actions = currentNode?.actions ?? [];
  const combos = currentNode?.combos;
  const nodeLock = useMemo(
    () => (currentNode ? lockForNode(locks, currentNode.node_id) : null),
    [locks, currentNode],
  );

  const normalized = useMemo(() => normalizeProbs(lockDraft.probs), [lockDraft.probs]);
  const rawSum = normalized.sum;

  const selectedHands = useMemo(() => {
    const labels = combos ?? [];
    if (lockDraft.kind === "full") {
      return labels.map((combo, index) => ({ index, combo }));
    }
    return lockDraft.handIndices.map((index) => ({
      index,
      combo: labels[index] ?? `#${index}`,
    }));
  }, [lockDraft.kind, lockDraft.handIndices, combos]);

  const busy = phase === "solving" || phase === "building";

  if (!open) {
    return null;
  }

  return (
    <aside className="lock-drawer" aria-label="Lock editor">
      <div className="lock-drawer__header">
        <div>
          <h2 className="panel-title">Lock editor</h2>
          <p className="lock-drawer__node muted">
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
        <button
          type="button"
          className="toolbar-btn"
          onClick={() => setLockDrawerOpen(false)}
        >
          Close
        </button>
      </div>

      <div className="lock-drawer__body">
        <section className="lock-drawer__section" aria-label="Lock kind">
          <div className="lock-drawer__section-title">Constraint scope</div>
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
          <p className="hint">
            A 0% action inside a row that sums to 1 is a real constraint. An all-zero row is
            rejected — use Unlock (DELETE) to remove a lock.
          </p>
        </section>

        <section className="lock-drawer__section" aria-label="Selected hands">
          <div className="lock-drawer__section-title">
            Hands{" "}
            <span className="muted tabular">
              {lockDraft.kind === "full"
                ? `(full · ${combos?.length ?? 0})`
                : `(${lockDraft.handIndices.length})`}
            </span>
          </div>
          {lockDraft.kind === "selected" && lockDraft.handIndices.length === 0 ? (
            <p className="empty-hint">
              Select combos in the inspector, or toggle rows below after seeding.
            </p>
          ) : (
            <ul className="lock-hand-list">
              {selectedHands.map(({ index, combo }) => {
                const locked = isHandLocked(nodeLock, index);
                const inDraft =
                  lockDraft.kind === "full" || lockDraft.handIndices.includes(index);
                return (
                  <li
                    key={`${index}-${combo}`}
                    className="lock-hand-row"
                    data-locked={locked ? "true" : "false"}
                    data-in-draft={inDraft ? "true" : "false"}
                  >
                    {lockDraft.kind === "selected" ? (
                      <input
                        type="checkbox"
                        checked={lockDraft.handIndices.includes(index)}
                        onChange={() => toggleLockHand(index)}
                        aria-label={`Include ${combo}`}
                      />
                    ) : (
                      <span className="lock-hand-row__mark" aria-hidden>
                        ●
                      </span>
                    )}
                    <code>{combo}</code>
                    <span className="muted tabular">#{index}</span>
                    <span className="lock-hand-row__badge">
                      {locked ? "locked" : "free"}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {lockDraft.kind === "selected" && (combos?.length ?? 0) > 0 ? (
            <details className="lock-hand-picker">
              <summary>Browse node combos</summary>
              <ul className="lock-hand-list lock-hand-list--compact">
                {(combos ?? []).map((combo, index) => {
                  const locked = isHandLocked(nodeLock, index);
                  const selected = lockDraft.handIndices.includes(index);
                  return (
                    <li
                      key={`pick-${index}`}
                      className="lock-hand-row"
                      data-locked={locked ? "true" : "false"}
                      data-in-draft={selected ? "true" : "false"}
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleLockHand(index)}
                        aria-label={`Toggle ${combo}`}
                      />
                      <code>{combo}</code>
                      <span className="muted tabular">#{index}</span>
                      <span className="lock-hand-row__badge">
                        {locked ? "locked" : "free"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </details>
          ) : null}
        </section>

        <section className="lock-drawer__section" aria-label="Probability row">
          <div className="lock-drawer__section-title">Action probabilities</div>
          {actions.length === 0 ? (
            <p className="empty-hint">No actions at this node.</p>
          ) : (
            <div className="lock-prob-grid">
              {actions.map((label, index) => (
                <label key={`${label}-${index}`} className="lock-prob-row">
                  <span className="lock-prob-row__label">{label}</span>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.01}
                    className="lock-prob-input tabular"
                    value={Number.isFinite(lockDraft.probs[index]) ? lockDraft.probs[index] : 0}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      setLockProbAt(index, Number.isFinite(next) ? next : 0);
                    }}
                  />
                  <span className="muted tabular">
                    {formatProbPct(
                      Number.isFinite(lockDraft.probs[index]) ? lockDraft.probs[index] : 0,
                    )}
                  </span>
                </label>
              ))}
            </div>
          )}
          <div className="lock-prob-sum">
            <span className="muted">Sum</span>
            <strong className="tabular">{rawSum.toFixed(4)}</strong>
            {rawSum === 0 && actions.length > 0 ? (
              <span className="lock-prob-sum__note">all-zero constraint</span>
            ) : null}
          </div>
          <div className="lock-prob-preview" aria-label="Normalized preview">
            <span className="muted">Preview</span>
            {actions.length === 0 ? (
              <span>—</span>
            ) : rawSum === 0 ? (
              <span className="tabular">
                {actions.map((label) => `${label}: 0%`).join(" · ")}
              </span>
            ) : (
              <span className="tabular">
                {actions
                  .map(
                    (label, index) =>
                      `${label}: ${formatProbPct(normalized.probs[index] ?? 0)}`,
                  )
                  .join(" · ")}
              </span>
            )}
          </div>
        </section>

        <section className="lock-drawer__section lock-drawer__actions" aria-label="Lock actions">
          <button type="button" className="toolbar-btn" onClick={() => seedLockFromStrategy()}>
            Seed from strategy
          </button>
          <button type="button" className="toolbar-btn" onClick={() => revertLockDraft()}>
            Revert draft
          </button>
          <button
            type="button"
            className="toolbar-btn primary"
            onClick={() => void applyLock()}
            disabled={!currentNode || currentNode.kind !== "decision"}
          >
            Apply lock
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => void unlockHands()}
            disabled={lockDraft.handIndices.length === 0}
          >
            Unlock selected
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
        </section>

        <section className="lock-drawer__section" aria-label="Resolve locked">
          <div className="lock-drawer__section-title">Resolve</div>
          <label className="lock-warm-start">
            <input
              type="checkbox"
              checked={warmStart}
              onChange={(event) => setWarmStart(event.target.checked)}
            />
            <span>
              Warm-start from current strategy
              <span className="muted"> (unchecked = reset re-solve)</span>
            </span>
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
          <p className="hint">
            Resolve keeps the baseline solution and publishes a new solution id for the
            locked scenario.
          </p>
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
                const atCurrent = currentNode && entry.node_id === currentNode.node_id;
                const handCount =
                  entry.kind === "full"
                    ? "all"
                    : String(entry.hand_indices?.length ?? 0);
                return (
                  <li
                    key={`${entry.node_id}-${entry.kind}-${handCount}`}
                    className="lock-record-row"
                    data-current={atCurrent ? "true" : "false"}
                  >
                    <code>{entry.node_id}</code>
                    <span>{entry.kind}</span>
                    <span className="tabular muted">{handCount} hands</span>
                    {atCurrent && nodeLock ? (
                      <span className="lock-hand-row__badge">here</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {message ? <p className="lock-drawer__message muted">{message}</p> : null}
      </div>
    </aside>
  );
}
