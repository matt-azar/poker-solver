/**
 * Cold Study with no published solution — New / Open / recent only.
 * Avoids default-board Study chrome, empty matrix, and “No actions…” noise.
 */
import { useEffect, useState } from "react";
import { DEFAULT_SPOT } from "../../domain/types";
import { useSolutionsCatalogueUi } from "../../state/solutionsCatalogueUi";
import { useStudyStore } from "../../state/studyStore";

function formatMtime(mtime: number): string {
  if (!mtime) {
    return "";
  }
  try {
    return new Date(mtime * 1000).toLocaleString();
  } catch {
    return "";
  }
}

export function StartupEmptyState() {
  const connection = useStudyStore((s) => s.connection);
  const libraryLists = useStudyStore((s) => s.libraryLists);
  const loadRecent = useStudyStore((s) => s.loadRecent);
  const openSolution = useStudyStore((s) => s.openSolution);
  const setWorkspace = useStudyStore((s) => s.setWorkspace);
  const updateDraft = useStudyStore((s) => s.updateDraft);
  const openCatalogue = useSolutionsCatalogueUi((s) => s.openCatalogue);
  const [busyPath, setBusyPath] = useState<string | null>(null);

  useEffect(() => {
    void loadRecent();
  }, [loadRecent, connection]);

  const onNew = () => {
    updateDraft({ ...DEFAULT_SPOT });
    setWorkspace("build");
  };

  const onOpenRecent = async (path: string) => {
    setBusyPath(path);
    try {
      await openSolution(path);
    } finally {
      setBusyPath(null);
    }
  };

  return (
    <div className="startup-empty" role="main" aria-label="No solution open">
      <div className="startup-empty__actions">
        <button type="button" className="toolbar-btn primary" onClick={onNew}>
          New solution
        </button>
        <button
          type="button"
          className="toolbar-btn"
          onClick={() => openCatalogue("open")}
        >
          Open solution
        </button>
      </div>

      <section className="startup-empty__recent" aria-labelledby="startup-recent-title">
        <div className="startup-empty__recent-head">
          <h2 id="startup-recent-title">Recent</h2>
          <button
            type="button"
            className="toolbar-btn"
            disabled={libraryLists.loading}
            onClick={() => void loadRecent()}
          >
            Refresh
          </button>
        </div>
        {libraryLists.recent.length === 0 ? (
          <p className="startup-empty__empty" role="status">
            No recent solutions.
          </p>
        ) : (
          <ul className="startup-empty__list">
            {libraryLists.recent.map((entry) => (
              <li key={entry.path} className="startup-empty__row">
                <div className="startup-empty__row-main">
                  <span className="startup-empty__name">{entry.name}</span>
                  <span className="startup-empty__meta" title={entry.path}>
                    {entry.path}
                  </span>
                  {entry.mtime ? (
                    <span className="startup-empty__meta tabular">
                      {formatMtime(entry.mtime)}
                    </span>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="toolbar-btn primary"
                  disabled={busyPath !== null}
                  onClick={() => void onOpenRecent(entry.path)}
                >
                  {busyPath === entry.path ? "Opening…" : "Open"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
