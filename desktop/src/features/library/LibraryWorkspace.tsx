import { useEffect, useMemo, useState } from "react";
import { groupRangesByFolder } from "../../domain/analysis";
import { getBettingTreeCatalogue } from "../../domain/bettingTreeCatalogue";
import {
  getSolutionsCatalogue,
  type SavedSolution,
} from "../../domain/solutionsCatalogue";
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

function matchesQuery(haystack: string, query: string): boolean {
  if (!query) {
    return true;
  }
  return haystack.toLowerCase().includes(query);
}

/** Name + folder/path + board/street tokens in those strings. */
function solutionMatches(entry: SavedSolution, query: string): boolean {
  if (!query) {
    return true;
  }
  const blob = `${entry.displayName} ${entry.folder} ${entry.path}`.toLowerCase();
  return matchesQuery(blob, query);
}

export function LibraryWorkspace() {
  const connection = useStudyStore((s) => s.connection);
  const libraryLists = useStudyStore((s) => s.libraryLists);
  const loadRecent = useStudyStore((s) => s.loadRecent);
  const loadTemplates = useStudyStore((s) => s.loadTemplates);
  const loadRanges = useStudyStore((s) => s.loadRanges);
  const openSolution = useStudyStore((s) => s.openSolution);
  const applyTemplate = useStudyStore((s) => s.applyTemplate);
  const applyRangePreset = useStudyStore((s) => s.applyRangePreset);
  const updateDraft = useStudyStore((s) => s.updateDraft);
  const setWorkspace = useStudyStore((s) => s.setWorkspace);
  const openCatalogue = useSolutionsCatalogueUi((s) => s.openCatalogue);
  const [rangeTarget, setRangeTarget] = useState<"oop" | "ip">("oop");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [treeRevision, setTreeRevision] = useState(0);

  const engineNeeded = connection === "disconnected";
  const normalizedQuery = query.trim().toLowerCase();

  const catalogueSolutions = useMemo(() => {
    void treeRevision;
    return getSolutionsCatalogue().list();
  }, [treeRevision, libraryLists.recent]);

  const treeTemplates = useMemo(() => {
    void treeRevision;
    return getBettingTreeCatalogue().list();
  }, [treeRevision]);

  const filteredSolutions = useMemo(
    () => catalogueSolutions.filter((entry) => solutionMatches(entry, normalizedQuery)),
    [catalogueSolutions, normalizedQuery],
  );

  const filteredTrees = useMemo(() => {
    if (!normalizedQuery) {
      return treeTemplates;
    }
    return treeTemplates.filter((entry) => {
      const blob =
        `${entry.displayName} ${JSON.stringify(entry.document.tree)}`.toLowerCase();
      return matchesQuery(blob, normalizedQuery);
    });
  }, [treeTemplates, normalizedQuery]);

  const filteredRanges = useMemo(() => {
    if (!normalizedQuery) {
      return libraryLists.ranges;
    }
    return libraryLists.ranges.filter((entry) => {
      const blob = `${entry.name} ${entry.id} ${entry.folder ?? ""}`.toLowerCase();
      return matchesQuery(blob, normalizedQuery);
    });
  }, [libraryLists.ranges, normalizedQuery]);

  const rangeGroups = useMemo(
    () => groupRangesByFolder(filteredRanges),
    [filteredRanges],
  );

  useEffect(() => {
    // Catalogue / FS lists do not require a live engine session (#288/#289).
    void loadRecent();
    void loadTemplates();
    void loadRanges();
    setTreeRevision((value) => value + 1);
  }, [loadRecent, loadTemplates, loadRanges, connection]);

  const refreshAll = () => {
    void loadRecent();
    void loadTemplates();
    void loadRanges();
    setTreeRevision((value) => value + 1);
  };

  const onOpenSolution = async (path: string) => {
    if (engineNeeded) {
      return;
    }
    setBusyId(`solution:${path}`);
    try {
      await openSolution(path);
      setWorkspace("study");
    } finally {
      setBusyId(null);
    }
  };

  const onApplyTemplate = async (id: string) => {
    if (engineNeeded) {
      return;
    }
    setBusyId(`template:${id}`);
    try {
      await applyTemplate(id);
      setWorkspace("build");
    } finally {
      setBusyId(null);
    }
  };

  const onApplyRange = async (id: string) => {
    if (engineNeeded) {
      return;
    }
    setBusyId(`range:${id}`);
    try {
      await applyRangePreset(id, rangeTarget);
      setWorkspace("build");
    } finally {
      setBusyId(null);
    }
  };

  const onApplyTree = (id: string) => {
    const entry = getBettingTreeCatalogue().list().find((item) => item.id === id);
    if (!entry) {
      return;
    }
    updateDraft(entry.document.tree);
    setWorkspace("build");
  };

  return (
    <div className="library-workspace">
      <header className="library-header">
        <div>
          <h1>Library</h1>
        </div>
        <div className="library-header__tools">
          <label className="library-search">
            Search
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Name, board, street…"
              aria-label="Search library"
            />
          </label>
          <button
            type="button"
            className="toolbar-btn"
            disabled={libraryLists.loading}
            onClick={refreshAll}
          >
            Refresh
          </button>
        </div>
      </header>

      {engineNeeded ? (
        <p className="library-banner" role="status">
          Engine disconnected — browsing local entries. Open / Apply need a
          reconnect.
        </p>
      ) : null}

      <div className="library-grid">
        <section className="library-section" aria-labelledby="library-solutions-title">
          <div className="library-section__head">
            <h2 id="library-solutions-title">Solutions</h2>
            <span className="library-count tabular">{filteredSolutions.length}</span>
          </div>
          <div className="library-section__actions">
            <button
              type="button"
              className="toolbar-btn"
              onClick={() => openCatalogue("open")}
            >
              Browse catalogue
            </button>
          </div>
          {filteredSolutions.length === 0 ? (
            <p className="library-empty">No solutions.</p>
          ) : (
            <ul className="library-list">
              {filteredSolutions.map((entry) => (
                <li key={entry.id} className="library-row">
                  <div className="library-row__main">
                    <span className="library-row__name">{entry.displayName}</span>
                    <span className="library-row__meta" title={entry.path}>
                      {entry.folder ? `${entry.folder}/` : ""}
                      {entry.path}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="toolbar-btn primary"
                    disabled={engineNeeded || busyId !== null}
                    title={engineNeeded ? "Reconnect to open" : undefined}
                    onClick={() => void onOpenSolution(entry.path)}
                  >
                    {busyId === `solution:${entry.path}` ? "Opening…" : "Open"}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {libraryLists.recent.length > 0 ? (
            <div className="library-recent-block">
              <h3 className="library-folder__title">Recent</h3>
              <ul className="library-list">
                {libraryLists.recent
                  .filter((entry) =>
                    matchesQuery(
                      `${entry.name} ${entry.path}`.toLowerCase(),
                      normalizedQuery,
                    ),
                  )
                  .map((entry) => (
                    <li key={`recent:${entry.path}`} className="library-row">
                      <div className="library-row__main">
                        <span className="library-row__name">{entry.name}</span>
                        <span className="library-row__meta" title={entry.path}>
                          {entry.path}
                        </span>
                        {entry.mtime ? (
                          <span className="library-row__meta tabular">
                            {formatMtime(entry.mtime)}
                          </span>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        className="toolbar-btn primary"
                        disabled={engineNeeded || busyId !== null}
                        title={engineNeeded ? "Reconnect to open" : undefined}
                        onClick={() => void onOpenSolution(entry.path)}
                      >
                        {busyId === `solution:${entry.path}`
                          ? "Opening…"
                          : "Open"}
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}
        </section>

        <section className="library-section" aria-labelledby="library-ranges-title">
          <div className="library-section__head">
            <h2 id="library-ranges-title">Ranges</h2>
            <span className="library-count tabular">{filteredRanges.length}</span>
          </div>
          <div className="library-range-target">
            <span className="library-muted">Target seat</span>
            <label className="library-radio">
              <input
                type="radio"
                name="library-range-target"
                checked={rangeTarget === "oop"}
                onChange={() => setRangeTarget("oop")}
              />
              OOP
            </label>
            <label className="library-radio">
              <input
                type="radio"
                name="library-range-target"
                checked={rangeTarget === "ip"}
                onChange={() => setRangeTarget("ip")}
              />
              IP
            </label>
          </div>
          {filteredRanges.length === 0 ? (
            <p className="library-empty">No ranges.</p>
          ) : (
            <div className="library-range-folders">
              {rangeGroups.map((group) => (
                <div key={group.folder || "root"} className="library-folder">
                  <h3 className="library-folder__title">{group.label}</h3>
                  <ul className="library-list">
                    {group.entries.map((entry) => (
                      <li key={entry.id} className="library-row">
                        <div className="library-row__main">
                          <span className="library-row__name">{entry.name}</span>
                          <span className="library-row__meta">{entry.id}</span>
                        </div>
                        <button
                          type="button"
                          className="toolbar-btn primary"
                          disabled={engineNeeded || busyId !== null}
                          title={
                            engineNeeded
                              ? "Reconnect to apply"
                              : `Apply → ${rangeTarget.toUpperCase()}`
                          }
                          onClick={() => void onApplyRange(entry.id)}
                        >
                          {busyId === `range:${entry.id}`
                            ? "Applying…"
                            : `Apply → ${rangeTarget.toUpperCase()}`}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>

        <section
          className="library-section"
          aria-labelledby="library-trees-title"
        >
          <div className="library-section__head">
            <h2 id="library-trees-title">Tree templates</h2>
            <span className="library-count tabular">{filteredTrees.length}</span>
          </div>
          {filteredTrees.length === 0 && libraryLists.templates.length === 0 ? (
            <p className="library-empty">No tree templates.</p>
          ) : null}
          {filteredTrees.length > 0 ? (
            <ul className="library-list">
              {filteredTrees.map((entry) => (
                <li key={entry.id} className="library-row">
                  <div className="library-row__main">
                    <span className="library-row__name">{entry.displayName}</span>
                    <span className="library-row__meta">Betting tree</span>
                  </div>
                  <button
                    type="button"
                    className="toolbar-btn primary"
                    onClick={() => onApplyTree(entry.id)}
                  >
                    Apply
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {libraryLists.templates.length > 0 ? (
            <div className="library-recent-block">
              <h3 className="library-folder__title">Engine templates</h3>
              <ul className="library-list">
                {libraryLists.templates
                  .filter((entry) =>
                    matchesQuery(
                      `${entry.name} ${entry.id}`.toLowerCase(),
                      normalizedQuery,
                    ),
                  )
                  .map((entry) => (
                    <li key={entry.id} className="library-row">
                      <div className="library-row__main">
                        <span className="library-row__name">{entry.name}</span>
                        <span className="library-row__meta">{entry.id}</span>
                      </div>
                      <button
                        type="button"
                        className="toolbar-btn primary"
                        disabled={engineNeeded || busyId !== null}
                        title={engineNeeded ? "Reconnect to apply" : undefined}
                        onClick={() => void onApplyTemplate(entry.id)}
                      >
                        {busyId === `template:${entry.id}`
                          ? "Applying…"
                          : "Apply"}
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
