import { useEffect, useState } from "react";
import { compareNoteIsValid } from "../../domain/setup";
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

  // Prefer the live Study node; never fall back to a stale compare root across solutions.
  const nodeId = currentNode?.node_id ?? null;
  const canCompare = Boolean(baselineSolutionId && solutionId && nodeId);
  const missingBaseline = !baselineSolutionId;
  const noteValid = compareNoteIsValid(
    compareNote,
    baselineSolutionId,
    solutionId,
    nodeId,
  );

  useEffect(() => {
    // When the note is already valid (or compare is unavailable), clear busy.
    // Otherwise a successful load flips noteValid→true, the effect cleanup sets
    // cancelled=true, and finally skips setBusy(false) — Refresh stays stuck.
    if (!canCompare || noteValid) {
      setBusy(false);
      return;
    }
    let cancelled = false;
    setBusy(true);
    void loadCompare(nodeId ?? undefined).finally(() => {
      if (!cancelled) {
        setBusy(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [canCompare, loadCompare, nodeId, noteValid]);

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
          <h2>No baseline</h2>
          <p>
            Lock hands in Study, then run <strong>Resolve locked</strong> to create a baseline.
          </p>
        </div>
      ) : !solutionId ? (
        <div className="compare-empty" role="status">
          <h2>No solution</h2>
          <p>Solve or open a solution first.</p>
        </div>
      ) : !nodeId ? (
        <div className="compare-empty" role="status">
          <h2>No decision node</h2>
          <p>Select a decision node in Study, then refresh.</p>
        </div>
      ) : noteValid && compareNote ? (
        <>
          <CompareHeader note={compareNote} />
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
          {!busy ? <p className="muted">Press Refresh compare.</p> : null}
        </div>
      )}
    </div>
  );
}
