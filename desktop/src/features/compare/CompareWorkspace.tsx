import { useState } from "react";
import { useStudyStore } from "../../state/studyStore";
import { CompareHeader } from "./CompareHeader";
import {
  CompareHandsTable,
  type HandFilter,
  type HandSort,
} from "./CompareHandsTable";

export function CompareWorkspace() {
  const compareNote = useStudyStore((s) => s.compareNote);
  const baselineSolutionId = useStudyStore((s) => s.baselineSolutionId);
  const solutionId = useStudyStore((s) => s.solutionId);
  const currentNode = useStudyStore((s) => s.currentNode);
  const message = useStudyStore((s) => s.message);
  const loadCompare = useStudyStore((s) => s.loadCompare);
  const setWorkspace = useStudyStore((s) => s.setWorkspace);
  const navigateTo = useStudyStore((s) => s.navigateTo);

  const [filter, setFilter] = useState<HandFilter>("all");
  const [sort, setSort] = useState<HandSort>("delta");
  const [busy, setBusy] = useState(false);

  const nodeId = currentNode?.node_id ?? compareNote?.node_id ?? null;
  const canCompare = Boolean(baselineSolutionId && solutionId && nodeId);
  const missingBaseline = !baselineSolutionId;

  async function onRefresh() {
    setBusy(true);
    try {
      await loadCompare(nodeId ?? undefined);
    } finally {
      setBusy(false);
    }
  }

  async function onOpenInStudy() {
    const target = compareNote?.node_id || nodeId;
    setWorkspace("study");
    if (target) {
      await navigateTo(target);
    }
  }

  return (
    <div className="compare-workspace">
      <div className="compare-toolbar">
        <div className="compare-toolbar__title">
          <h1>Compare</h1>
          <p className="muted">Baseline revision vs locked scenario at a decision node.</p>
        </div>
        <div className="compare-toolbar__actions">
          <button
            type="button"
            className="toolbar-btn"
            disabled={busy || !canCompare}
            onClick={() => void onRefresh()}
          >
            {busy ? "Loading…" : "Refresh compare"}
          </button>
          <button
            type="button"
            className="toolbar-btn primary"
            disabled={!nodeId}
            onClick={() => void onOpenInStudy()}
          >
            Open in Study
          </button>
        </div>
      </div>

      {missingBaseline ? (
        <div className="compare-empty" role="status">
          <h2>No baseline revision</h2>
          <p>
            Compare needs a retained baseline. Apply node locks, then run{" "}
            <strong>Resolve locked</strong> — the engine keeps the prior solution as baseline and
            publishes a new scenario id. Status exposes <code>baseline_solution_id</code>; open this
            workspace again after resolve completes.
          </p>
          <p className="muted">
            Scenario: {solutionId ?? "none"} · Node: {nodeId ?? "none"}
          </p>
        </div>
      ) : !solutionId ? (
        <div className="compare-empty" role="status">
          <h2>No scenario solution</h2>
          <p>Load or solve a solution, then resolve-locked so both baseline and scenario exist.</p>
        </div>
      ) : !nodeId ? (
        <div className="compare-empty" role="status">
          <h2>No decision node</h2>
          <p>Open Study, navigate to a decision node, then refresh compare.</p>
        </div>
      ) : compareNote ? (
        <>
          <CompareHeader note={compareNote} />
          {currentNode?.node_id && compareNote.node_id !== currentNode.node_id ? (
            <p className="compare-store-message" role="status">
              Showing compare for {compareNote.node_id}; Study is on {currentNode.node_id}. Refresh
              compare to reload for the current node.
            </p>
          ) : null}
          {message && /compare|arity|disagree|baseline|scenario/i.test(message) ? (
            <p className="compare-store-message" role="status">
              {message}
            </p>
          ) : null}
          <CompareHandsTable
            actions={compareNote.actions}
            hands={compareNote.hands}
            filter={filter}
            sort={sort}
            onFilterChange={setFilter}
            onSortChange={setSort}
          />
        </>
      ) : (
        <div className="compare-empty" role="status">
          <h2>{busy ? "Loading compare…" : "Compare not loaded"}</h2>
          {message ? <p className="compare-store-message">{message}</p> : null}
          {!busy ? (
            <p className="muted">
              Baseline {baselineSolutionId} → scenario {solutionId} at {nodeId}. Press Refresh
              compare. If revisions disagree on action arity at this node, the API errors and the
              store message appears here — zeros are not invented for missing actions.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
