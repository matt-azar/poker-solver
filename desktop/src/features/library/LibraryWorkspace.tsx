import { useEffect, useState } from "react";
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

export function LibraryWorkspace() {
  const connection = useStudyStore((s) => s.connection);
  const libraryLists = useStudyStore((s) => s.libraryLists);
  const loadRecent = useStudyStore((s) => s.loadRecent);
  const loadTemplates = useStudyStore((s) => s.loadTemplates);
  const loadRanges = useStudyStore((s) => s.loadRanges);
  const openSolution = useStudyStore((s) => s.openSolution);
  const applyTemplate = useStudyStore((s) => s.applyTemplate);
  const applyRangePreset = useStudyStore((s) => s.applyRangePreset);
  const setWorkspace = useStudyStore((s) => s.setWorkspace);
  const [rangeTarget, setRangeTarget] = useState<"oop" | "ip">("oop");
  const [busyId, setBusyId] = useState<string | null>(null);

  const disconnected = connection === "disconnected";

  useEffect(() => {
    if (disconnected) {
      return;
    }
    void loadRecent();
    void loadTemplates();
    void loadRanges();
  }, [disconnected, loadRecent, loadTemplates, loadRanges]);

  const refreshAll = () => {
    void loadRecent();
    void loadTemplates();
    void loadRanges();
  };

  const onOpenRecent = async (path: string) => {
    setBusyId(`recent:${path}`);
    try {
      await openSolution(path);
      setWorkspace("study");
    } finally {
      setBusyId(null);
    }
  };

  const onApplyTemplate = async (id: string) => {
    setBusyId(`template:${id}`);
    try {
      await applyTemplate(id);
    } finally {
      setBusyId(null);
    }
  };

  const onApplyRange = async (id: string) => {
    setBusyId(`range:${id}`);
    try {
      await applyRangePreset(id, rangeTarget);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="library-workspace">
      <header className="library-header">
        <div>
          <h1>Library</h1>
          <p className="library-muted">
            Recent solutions, street-config templates, and named range presets from the engine.
          </p>
        </div>
        <button
          type="button"
          className="toolbar-btn"
          disabled={disconnected || libraryLists.loading}
          onClick={refreshAll}
        >
          Refresh
        </button>
      </header>

      {disconnected ? (
        <p className="library-empty" role="status">
          Engine disconnected — start the explorer to load recent files, templates, and ranges.
        </p>
      ) : (
        <div className="library-grid">
          <section className="library-section" aria-labelledby="library-recent-title">
            <div className="library-section__head">
              <h2 id="library-recent-title">Recent solutions</h2>
              <span className="library-count tabular">{libraryLists.recent.length}</span>
            </div>
            {libraryLists.recent.length === 0 ? (
              <p className="library-empty">No recent solutions yet. Save or open a PSOL to populate this list.</p>
            ) : (
              <ul className="library-list">
                {libraryLists.recent.map((entry) => (
                  <li key={entry.path} className="library-row">
                    <div className="library-row__main">
                      <span className="library-row__name">{entry.name}</span>
                      <span className="library-row__meta" title={entry.path}>
                        {entry.path}
                      </span>
                      {entry.mtime ? (
                        <span className="library-row__meta tabular">{formatMtime(entry.mtime)}</span>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="toolbar-btn primary"
                      disabled={busyId !== null}
                      onClick={() => void onOpenRecent(entry.path)}
                    >
                      {busyId === `recent:${entry.path}` ? "Opening…" : "Open"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="library-section" aria-labelledby="library-templates-title">
            <div className="library-section__head">
              <h2 id="library-templates-title">Templates</h2>
              <span className="library-count tabular">{libraryLists.templates.length}</span>
            </div>
            {libraryLists.templates.length === 0 ? (
              <p className="library-empty">
                No templates found. Place street-config documents under configs/templates.
              </p>
            ) : (
              <ul className="library-list">
                {libraryLists.templates.map((entry) => (
                  <li key={entry.id} className="library-row">
                    <div className="library-row__main">
                      <span className="library-row__name">{entry.name}</span>
                      <span className="library-row__meta">{entry.id}</span>
                    </div>
                    <button
                      type="button"
                      className="toolbar-btn primary"
                      disabled={busyId !== null}
                      onClick={() => void onApplyTemplate(entry.id)}
                    >
                      {busyId === `template:${entry.id}` ? "Applying…" : "Apply"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="library-section" aria-labelledby="library-ranges-title">
            <div className="library-section__head">
              <h2 id="library-ranges-title">Range presets</h2>
              <span className="library-count tabular">{libraryLists.ranges.length}</span>
            </div>
            <div className="library-range-target">
              <span className="library-muted">Apply into</span>
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
            {libraryLists.ranges.length === 0 ? (
              <p className="library-empty">
                No range presets found. Place range strings under configs/ranges.
              </p>
            ) : (
              <ul className="library-list">
                {libraryLists.ranges.map((entry) => (
                  <li key={entry.id} className="library-row">
                    <div className="library-row__main">
                      <span className="library-row__name">{entry.name}</span>
                      <span className="library-row__meta">{entry.id}</span>
                    </div>
                    <button
                      type="button"
                      className="toolbar-btn primary"
                      disabled={busyId !== null}
                      onClick={() => void onApplyRange(entry.id)}
                    >
                      {busyId === `range:${entry.id}` ? "Applying…" : `Apply → ${rangeTarget.toUpperCase()}`}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
