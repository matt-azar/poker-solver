import { useMemo } from "react";
import {
  editForNode,
  formatProbPct,
  isHandEdited,
  normalizeProbs,
} from "../../domain/strategyEdits";
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

/** Free-form stored-strategy editor — separate from the Lock drawer (Pio S5). */
export function StrategyEditDrawer() {
  const open = useStudyStore((s) => s.strategyEditDrawerOpen);
  const setStrategyEditDrawerOpen = useStudyStore((s) => s.setStrategyEditDrawerOpen);
  const currentNode = useStudyStore((s) => s.currentNode);
  const strategyEdits = useStudyStore((s) => s.strategyEdits);
  const draft = useStudyStore((s) => s.strategyEditDraft);
  const setStrategyEditKind = useStudyStore((s) => s.setStrategyEditKind);
  const setStrategyEditProbAt = useStudyStore((s) => s.setStrategyEditProbAt);
  const toggleStrategyEditHand = useStudyStore((s) => s.toggleStrategyEditHand);
  const seedStrategyEditFromStrategy = useStudyStore((s) => s.seedStrategyEditFromStrategy);
  const revertStrategyEditDraft = useStudyStore((s) => s.revertStrategyEditDraft);
  const applyStrategyEdit = useStudyStore((s) => s.applyStrategyEdit);
  const clearStrategyEditHands = useStudyStore((s) => s.clearStrategyEditHands);
  const clearStrategyEditNode = useStudyStore((s) => s.clearStrategyEditNode);
  const clearAllStrategyEdits = useStudyStore((s) => s.clearAllStrategyEdits);
  const message = useStudyStore((s) => s.message);
  const phase = useStudyStore((s) => s.phase);

  const actions = currentNode?.actions ?? [];
  const combos = currentNode?.combos;
  const nodeEdit = useMemo(
    () => (currentNode ? editForNode(strategyEdits, currentNode.node_id) : null),
    [strategyEdits, currentNode],
  );
  const normalized = useMemo(() => normalizeProbs(draft.probs), [draft.probs]);
  const rawSum = normalized.sum;

  const selectedHands = useMemo(() => {
    const labels = combos ?? [];
    if (draft.kind === "full") {
      return labels.map((combo, index) => ({ index, combo }));
    }
    return draft.handIndices.map((index) => ({
      index,
      combo: labels[index] ?? `#${index}`,
    }));
  }, [draft.kind, draft.handIndices, combos]);

  const busy = phase === "solving" || phase === "building";

  if (!open) {
    return null;
  }

  return (
    <aside className="lock-drawer strategy-edit-drawer" aria-label="Strategy editor">
      <div className="lock-drawer__header">
        <div>
          <h2 className="panel-title">Strategy editor</h2>
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
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 11 }}>
            Edits the stored average strategy for browse/EV. Does not lock CFR updates.
            Session-only — not saved in PSOL.
          </p>
        </div>
        <button
          type="button"
          className="toolbar-btn"
          onClick={() => setStrategyEditDrawerOpen(false)}
        >
          Close
        </button>
      </div>

      <div className="lock-drawer__body">
        <section className="lock-drawer__section" aria-label="Edit scope">
          <div className="lock-drawer__section-title">Edit scope</div>
          <div className="lock-kind-toggle" role="group" aria-label="Strategy edit kind">
            <button
              type="button"
              className="toolbar-btn"
              data-active={draft.kind === "selected" ? "true" : "false"}
              onClick={() => setStrategyEditKind("selected")}
            >
              Selected combos
            </button>
            <button
              type="button"
              className="toolbar-btn"
              data-active={draft.kind === "full" ? "true" : "false"}
              onClick={() => setStrategyEditKind("full")}
            >
              Full node
            </button>
          </div>
        </section>

        <section className="lock-drawer__section" aria-label="Selected hands">
          <div className="lock-drawer__section-title">
            Hands{" "}
            <span className="muted tabular">
              {draft.kind === "full"
                ? `(full · ${combos?.length ?? 0})`
                : `(${draft.handIndices.length})`}
            </span>
          </div>
          {draft.kind === "selected" && draft.handIndices.length === 0 ? (
            <p className="empty-hint">Select combos in the inspector.</p>
          ) : (
            <ul className="lock-hand-list">
              {selectedHands.map(({ index, combo }) => {
                const edited = isHandEdited(nodeEdit, index);
                const inDraft =
                  draft.kind === "full" || draft.handIndices.includes(index);
                return (
                  <li
                    key={`${index}-${combo}`}
                    className="lock-hand-row"
                    data-locked={edited ? "true" : "false"}
                    data-in-draft={inDraft ? "true" : "false"}
                  >
                    {draft.kind === "selected" ? (
                      <input
                        type="checkbox"
                        checked={draft.handIndices.includes(index)}
                        onChange={() => toggleStrategyEditHand(index)}
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
                      {edited ? "edited" : "solved"}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {draft.kind === "selected" && (combos?.length ?? 0) > 0 ? (
            <details className="lock-hand-picker">
              <summary>Browse node combos</summary>
              <ul className="lock-hand-list lock-hand-list--compact">
                {(combos ?? []).map((combo, index) => {
                  const edited = isHandEdited(nodeEdit, index);
                  const selected = draft.handIndices.includes(index);
                  return (
                    <li
                      key={`pick-${index}`}
                      className="lock-hand-row"
                      data-locked={edited ? "true" : "false"}
                      data-in-draft={selected ? "true" : "false"}
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleStrategyEditHand(index)}
                        aria-label={`Toggle ${combo}`}
                      />
                      <code>{combo}</code>
                      <span className="muted tabular">#{index}</span>
                      <span className="lock-hand-row__badge">
                        {edited ? "edited" : "solved"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </details>
          ) : null}
        </section>

        <section className="lock-drawer__section" aria-label="Probability row">
          <div className="lock-drawer__section-title">Action frequencies</div>
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
                    value={Number.isFinite(draft.probs[index]) ? draft.probs[index] : 0}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      setStrategyEditProbAt(index, Number.isFinite(next) ? next : 0);
                    }}
                  />
                  <span className="muted tabular">
                    {formatProbPct(Number.isFinite(draft.probs[index]) ? draft.probs[index] : 0)}
                  </span>
                </label>
              ))}
            </div>
          )}
          <div className="lock-prob-sum">
            <span className="muted">Sum</span>
            <strong className="tabular">{rawSum.toFixed(4)}</strong>
          </div>
          <div className="lock-prob-preview" aria-label="Normalized preview">
            <span className="muted">Preview</span>
            {actions.length === 0 ? (
              <span>—</span>
            ) : rawSum === 0 ? (
              <span className="muted">Cannot apply — probabilities must sum to 1</span>
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

        <section className="lock-drawer__section lock-drawer__actions" aria-label="Strategy edit actions">
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => seedStrategyEditFromStrategy()}
          >
            Seed from strategy
          </button>
          <button type="button" className="toolbar-btn" onClick={() => revertStrategyEditDraft()}>
            Revert draft
          </button>
          <button
            type="button"
            className="toolbar-btn primary"
            onClick={() => void applyStrategyEdit()}
            disabled={busy || !currentNode || currentNode.kind !== "decision"}
          >
            Apply strategy edit
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => void clearStrategyEditHands()}
            disabled={draft.handIndices.length === 0}
          >
            Clear selected edits
          </button>
          <button type="button" className="toolbar-btn" onClick={() => void clearStrategyEditNode()}>
            Clear node edits
          </button>
          <button
            type="button"
            className="toolbar-btn danger"
            onClick={() => void clearAllStrategyEdits()}
          >
            Clear all strategy edits
          </button>
        </section>

        <section className="lock-drawer__section" aria-label="Existing strategy edits">
          <div className="lock-drawer__section-title">
            Edits on solution{" "}
            <span className="muted tabular">({strategyEdits.length})</span>
          </div>
          {strategyEdits.length === 0 ? (
            <p className="empty-hint">No free-form strategy edits.</p>
          ) : (
            <ul className="lock-record-list">
              {strategyEdits.map((entry) => {
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
                    {atCurrent && nodeEdit ? (
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
