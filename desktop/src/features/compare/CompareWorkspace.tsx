import { useEffect, useState } from "react";
import {
  studyIpcFeatureAvailable,
  studyIpcUnavailableReason,
} from "../../engine/ipcCapabilities";
import { compareNoteIsValid } from "../../domain/setup";
import { useStudyStore } from "../../state/studyStore";
import { CompareHeader } from "./CompareHeader";
import {
  CompareHandsTable,
  type HandFilter,
  type HandSort,
} from "./CompareHandsTable";
import "../../styles/compare.css";

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

  const compareAvailable = studyIpcFeatureAvailable("compare");
  const compareUnavailableReason = studyIpcUnavailableReason("compare");

  // Prefer the live Study node; never fall back to a stale compare root across solutions.
  const nodeId = currentNode?.node_id ?? null;
  const canCompare = Boolean(
    compareAvailable && baselineSolutionId && solutionId && nodeId,
  );
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

  if (!compareAvailable) {
    return (
      <div className="compare-workspace">
        <div className="compare-toolbar">
          <div className="compare-toolbar__title">
            <h1>Compare</h1>
          </div>
          <div className="compare-toolbar__actions">
            <button
              type="button"
              className="toolbar-btn primary"
              onClick={() => setWorkspace("study")}
            >
              Back to Study
            </button>
          </div>
        </div>
        <div className="compare-empty" role="status">
          <h2>Unavailable over IPC</h2>
          <p>{compareUnavailableReason}</p>
        </div>
      </div>
    );
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
            Resolve locked from Node Locking to create a baseline, or open a
            study that already has one.
          </p>
          <div className="compare-empty__actions">
            <button
              type="button"
              className="toolbar-btn primary"
              onClick={() => setWorkspace("study")}
            >
              Open Study
            </button>
            <button
              type="button"
              className="toolbar-btn"
              onClick={() => setWorkspace("build")}
            >
              Create study
            </button>
            <button
              type="button"
              className="toolbar-btn"
              onClick={() => setWorkspace("library")}
            >
              Open Library
            </button>
          </div>
        </div>
      ) : !solutionId ? (
        <div className="compare-empty" role="status">
          <h2>No solution</h2>
          <p>Open or create a study to compare against the baseline.</p>
          <div className="compare-empty__actions">
            <button
              type="button"
              className="toolbar-btn primary"
              onClick={() => setWorkspace("library")}
            >
              Open Library
            </button>
            <button
              type="button"
              className="toolbar-btn"
              onClick={() => setWorkspace("build")}
            >
              Create study
            </button>
          </div>
        </div>
      ) : !nodeId ? (
        <div className="compare-empty" role="status">
          <h2>No decision node</h2>
          <p>Browse to a decision in Study, then return to Compare.</p>
          <div className="compare-empty__actions">
            <button
              type="button"
              className="toolbar-btn primary"
              onClick={() => setWorkspace("study")}
            >
              Open Study
            </button>
          </div>
        </div>
      ) : noteValid && compareNote ? (
        <>
          <CompareHeader
            note={compareNote}
            lineLabel={
              typeof currentNode?.line === "string" ? currentNode.line : null
            }
          />
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
        </div>
      )}
    </div>
  );
}
