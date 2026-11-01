import { useMemo, useRef, useState } from "react";
import {
  matchRangeProfiles,
  normalizeRakeEnvironmentLabel,
  type RangeProfile,
  type RangeProfileQuery,
} from "../../domain/profiles";
import { openSizeFromActions } from "../../domain/profiles/parse";
import { prepareStudyFromProfile } from "../../domain/assistant";
import {
  emptyStudySetupPreferences,
  loadStudySetupPreferences,
  potTypeFromActions,
} from "../../domain/setup";
import { useStudyStore } from "../../state/studyStore";

function readPrefs() {
  try {
    if (typeof localStorage === "undefined") {
      return emptyStudySetupPreferences();
    }
    return loadStudySetupPreferences(localStorage);
  } catch {
    return emptyStudySetupPreferences();
  }
}

function potLabel(profile: RangeProfile): string {
  return potTypeFromActions(profile.preflopActions) ?? "—";
}

function rakeLabel(profile: RangeProfile): string {
  return normalizeRakeEnvironmentLabel(profile.labels?.stakes);
}

function catalogueRowKey(profile: RangeProfile): string {
  return `${profile.id}@${String(profile.dataRevision)}`;
}

/**
 * Catalogue browser + JSON import for paired GTO/standard range profiles.
 * Import path: choose a schema-v1 JSON file (see configs/range-profiles/README.md).
 */
export function RangeCataloguePanel() {
  const getSetupCatalogue = useStudyStore((s) => s.getSetupCatalogue);
  const applySetupDraft = useStudyStore((s) => s.applySetupDraft);
  const draftRevision = useStudyStore((s) => s.draftRevision);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(true);
  const [tick, setTick] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [matchPot, setMatchPot] = useState<"" | "SRP" | "3BP" | "4BP">("");
  const [matchRake, setMatchRake] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const catalogue = useMemo(() => {
    void tick;
    return getSetupCatalogue();
  }, [getSetupCatalogue, tick]);

  const profiles = useMemo(() => catalogue.listProfiles(), [catalogue, tick]);

  const query: RangeProfileQuery | null = useMemo(() => {
    if (!matchPot && !matchRake.trim()) {
      return null;
    }
    const q: RangeProfileQuery = {};
    if (matchPot) {
      q.potType = matchPot;
    }
    if (matchRake.trim()) {
      q.stakesLabel = matchRake.trim();
    }
    return q;
  }, [matchPot, matchRake]);

  const matchResult = useMemo(() => {
    if (!query) {
      return null;
    }
    return matchRangeProfiles(query, profiles);
  }, [query, profiles]);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    let list = profiles;
    if (matchResult) {
      const exactIds = new Set(matchResult.exact.map((p) => p.id));
      const altIds = new Set(matchResult.alternatives.map((a) => a.profile.id));
      list = profiles.filter((p) => exactIds.has(p.id) || altIds.has(p.id));
      if (list.length === 0 && matchResult.none) {
        list = [];
      }
    }
    if (!needle) {
      return list;
    }
    return list.filter((p) => {
      const hay = [
        p.id,
        p.displayName,
        p.positions.oop,
        p.positions.ip,
        potLabel(p),
        rakeLabel(p),
        String(p.startingStackBb),
        p.provenance.classification,
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(needle);
    });
  }, [profiles, filter, matchResult]);

  function refresh() {
    setTick((n) => n + 1);
  }

  async function onImportFile(file: File) {
    setStatus(null);
    try {
      const text = await file.text();
      const result = catalogue.importProfile(text);
      if (result.error || !result.profile) {
        setStatus(result.error ?? "Import failed");
        return;
      }
      setSelectedId(result.profile.id);
      setStatus(
        `Imported ${result.profile.displayName} (${result.profile.provenance.classification}) · id ${result.profile.id}`,
      );
      refresh();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }

  function applyProfile(profile: RangeProfile) {
    const result = prepareStudyFromProfile(profile, readPrefs(), draftRevision);
    const outcome = applySetupDraft(result, { force: true });
    if (!outcome.ok) {
      setStatus(outcome.message);
      return;
    }
    setSelectedId(profile.id);
    setStatus(`Applied ${profile.displayName} to Build`);
  }

  function removeImport(id: string) {
    if (!catalogue.isUserImport(id)) {
      setStatus("Bundled fixtures cannot be removed — only user imports");
      return;
    }
    catalogue.removeUserImport(id);
    if (selectedId === id) {
      setSelectedId(null);
    }
    setStatus(`Removed user import ${id}`);
    refresh();
  }

  return (
    <section className="range-catalogue-panel build-section span-2" aria-label="Range catalogue">
      <div className="assistant-header">
        <h2>Range catalogue</h2>
        <div className="assistant-header-actions">
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => fileInputRef.current?.click()}
          >
            Import JSON…
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) {
                void onImportFile(file);
              }
            }}
          />
          <button type="button" className="toolbar-btn" onClick={() => setOpen((v) => !v)}>
            {open ? "Hide" : "Show"}
          </button>
        </div>
      </div>

      {open ? (
        <>
          <p className="assistant-lede">
            Paired OOP/IP GTO/standard ranges keyed by rake structure, pot type, positions, and
            stacks. Import schema-v1 JSON from{" "}
            <code>configs/range-profiles/</code> (or your own files). Bundled rows are synthetic
            fixtures — not a production strategic pack.
          </p>

          <div className="catalogue-filters">
            <label>
              Filter
              <input
                value={filter}
                placeholder="id, seats, 100NL, SRP…"
                onChange={(event) => setFilter(event.target.value)}
              />
            </label>
            <label>
              Match pot
              <select
                value={matchPot}
                onChange={(event) =>
                  setMatchPot(event.target.value as "" | "SRP" | "3BP" | "4BP")
                }
              >
                <option value="">Any</option>
                <option value="SRP">SRP</option>
                <option value="3BP">3BP</option>
                <option value="4BP">4BP</option>
              </select>
            </label>
            <label>
              Match rake
              <input
                value={matchRake}
                placeholder="cEV / 100NL"
                onChange={(event) => setMatchRake(event.target.value)}
              />
            </label>
          </div>

          {matchResult?.none ? (
            <p className="assistant-status muted">{matchResult.none}</p>
          ) : null}
          {matchResult && matchResult.exact.length > 0 ? (
            <p className="assistant-hint ok">
              {matchResult.exact.length} exact match
              {matchResult.exact.length === 1 ? "" : "es"} for the match filters
            </p>
          ) : null}
          {matchResult && matchResult.alternatives.length > 0 ? (
            <p className="assistant-hint">
              {matchResult.alternatives.length} labelled alternative
              {matchResult.alternatives.length === 1 ? "" : "s"}
            </p>
          ) : null}

          <div className="catalogue-table-wrap">
            <table className="catalogue-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Seats</th>
                  <th>Pot</th>
                  <th>Rake</th>
                  <th>Stack</th>
                  <th>Open</th>
                  <th>Source</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((profile) => {
                  const user = catalogue.isUserImport(profile.id);
                  const exact =
                    matchResult?.exact.some((p) => p.id === profile.id) ?? false;
                  const alt = matchResult?.alternatives.find(
                    (a) => a.profile.id === profile.id,
                  );
                  return (
                    <tr
                      key={catalogueRowKey(profile)}
                      data-selected={selectedId === profile.id ? "true" : undefined}
                      data-exact={exact ? "true" : undefined}
                    >
                      <td>
                        <div className="catalogue-name">{profile.displayName}</div>
                        <div className="catalogue-id tabular">{profile.id}</div>
                        {alt ? (
                          <div className="assistant-hint">
                            alt: {alt.differences.join(", ")}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        {profile.positions.oop} / {profile.positions.ip}
                      </td>
                      <td>{potLabel(profile)}</td>
                      <td>{rakeLabel(profile)}</td>
                      <td className="tabular">{profile.startingStackBb}bb</td>
                      <td className="tabular">
                        {openSizeFromActions(profile.preflopActions) ?? "—"}
                      </td>
                      <td>
                        {user ? "imported" : profile.provenance.classification}
                      </td>
                      <td>
                        <div className="catalogue-row-actions">
                          <button
                            type="button"
                            className="toolbar-btn primary"
                            onClick={() => applyProfile(profile)}
                          >
                            Apply
                          </button>
                          {user ? (
                            <button
                              type="button"
                              className="toolbar-btn danger"
                              onClick={() => removeImport(profile.id)}
                            >
                              Remove
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {visible.length === 0 ? (
                  <tr>
                    <td colSpan={8}>
                      <span className="assistant-hint">
                        No catalogue rows match. Import a schema-v1 JSON profile or clear filters.
                      </span>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          {status ? <p className="assistant-status">{status}</p> : null}
        </>
      ) : null}
    </section>
  );
}
