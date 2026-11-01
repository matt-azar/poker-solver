import { useMemo, useRef, useState } from "react";
import {
  composeSpotFromSeatActions,
  getSeatActionCatalogue,
  loadBundledSeatActions,
  matchRangeProfiles,
  normalizeRakeEnvironmentLabel,
  rankNearestNeighbors,
  type RangeProfile,
  type RangeProfileQuery,
  type SeatActionRange,
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
  const [matchStack, setMatchStack] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const catalogue = useMemo(() => {
    void tick;
    return getSetupCatalogue();
  }, [getSetupCatalogue, tick]);

  const profiles = useMemo(() => catalogue.listProfiles(), [catalogue, tick]);
  const seatAtoms = useMemo(() => {
    void tick;
    return getSeatActionCatalogue(loadBundledSeatActions).list();
  }, [tick]);
  const [seatFilter, setSeatFilter] = useState("");
  const visibleSeats = useMemo(() => {
    const needle = seatFilter.trim().toLowerCase();
    if (!needle) return seatAtoms;
    return seatAtoms.filter((a) =>
      [a.id, a.displayName, a.heroPosition, a.villainPosition, a.action, a.vsAction]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [seatAtoms, seatFilter]);

  const query: RangeProfileQuery | null = useMemo(() => {
    if (!matchPot && !matchRake.trim() && !matchStack.trim()) {
      return null;
    }
    const q: RangeProfileQuery = {};
    if (matchPot) {
      q.potType = matchPot;
    }
    if (matchRake.trim()) {
      q.stakesLabel = matchRake.trim();
    }
    const stack = Number(matchStack);
    if (matchStack.trim() && Number.isFinite(stack) && stack > 0) {
      q.stackBb = stack;
    }
    return q;
  }, [matchPot, matchRake, matchStack]);

  const matchResult = useMemo(() => {
    if (!query) {
      return null;
    }
    return matchRangeProfiles(query, profiles);
  }, [query, profiles]);

  const neighbors = useMemo(() => {
    if (!query) {
      return [];
    }
    return rankNearestNeighbors(query, profiles, 6);
  }, [query, profiles]);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    let list = profiles;
    if (matchResult) {
      const exactIds = new Set(matchResult.exact.map((p) => p.id));
      const altIds = new Set(matchResult.alternatives.map((a) => a.profile.id));
      const nearIds = new Set(neighbors.map((n) => n.profile.id));
      list = profiles.filter(
        (p) => exactIds.has(p.id) || altIds.has(p.id) || nearIds.has(p.id),
      );
      if (list.length === 0 && matchResult.none && neighbors.length === 0) {
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
  }, [profiles, filter, matchResult, neighbors]);

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
            Preferred grain is <strong>seat×action</strong> atoms from Matt’s Ranges.zip (bundled
            under packs/seat-action). The assistant composes them into OOP/IP for a spot. Paired
            JSON import remains available; synthetic fixtures are demos only.
          </p>

          <h3 className="catalogue-subhead">Seat×action atoms ({seatAtoms.length})</h3>
          <label>
            Filter atoms
            <input
              value={seatFilter}
              placeholder="BB call CO, BTN open, 3bet…"
              onChange={(event) => setSeatFilter(event.target.value)}
            />
          </label>
          <div className="catalogue-table-wrap">
            <table className="catalogue-table">
              <thead>
                <tr>
                  <th>Atom</th>
                  <th>Hero</th>
                  <th>Action</th>
                  <th>Vs</th>
                  <th>Villain</th>
                </tr>
              </thead>
              <tbody>
                {visibleSeats.slice(0, 40).map((atom: SeatActionRange) => (
                  <tr key={atom.id}>
                    <td>
                      <div className="catalogue-name">{atom.displayName}</div>
                      <div className="catalogue-id tabular">{atom.id}</div>
                    </td>
                    <td>{atom.heroPosition}</td>
                    <td>{atom.action}</td>
                    <td>{atom.vsAction}</td>
                    <td>{atom.villainPosition ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {visibleSeats.length > 40 ? (
            <p className="assistant-hint">Showing 40 of {visibleSeats.length} atoms</p>
          ) : null}
          <div className="catalogue-row-actions">
            <button
              type="button"
              className="toolbar-btn primary"
              onClick={() => {
                const composed = composeSpotFromSeatActions(seatAtoms, {
                  potType: matchPot || "SRP",
                  oopPosition: "BB",
                  ipPosition: "CO",
                });
                if (!composed.oopRange || !composed.ipRange) {
                  setStatus(
                    `Cannot compose: missing ${composed.missing.join(", ") || "atoms"}`,
                  );
                  return;
                }
                const draft = prepareStudyFromProfile(
                  {
                    schemaVersion: 1,
                    id: `composed-co-bb-${matchPot || "SRP"}`,
                    dataRevision: "1",
                    displayName: `Composed CO vs BB ${matchPot || "SRP"}`,
                    format: "cash_6max",
                    playerCount: 6,
                    positions: { oop: "BB", ip: "CO" },
                    preflopActions: [
                      { position: "CO", kind: "open", sizeBb: 2.5 },
                      { position: "BB", kind: "call", sizeBb: 1.5 },
                    ],
                    startingStackBb: 100,
                    blinds: { sb: 0.5, bb: 1 },
                    rake: { rate: 0, cap: 0, collection: "none", known: false },
                    labels: { intendedUse: "seat_action_composed" },
                    ranges: { oop: composed.oopRange, ip: composed.ipRange },
                    provenance: {
                      source: "seat-action-compose",
                      classification: "population_estimate",
                      notes: composed.summary.join("; "),
                    },
                  },
                  readPrefs(),
                  draftRevision,
                );
                const outcome = applySetupDraft(draft, { force: true });
                setStatus(
                  outcome.ok
                    ? `Applied composed CO vs BB ${matchPot || "SRP"} from seat×action atoms`
                    : outcome.message,
                );
              }}
            >
              Apply composed CO vs BB SRP
            </button>
          </div>

          <h3 className="catalogue-subhead">Paired profiles</h3>

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
            <label>
              Match stack
              <input
                value={matchStack}
                placeholder="e.g. 170"
                onChange={(event) => setMatchStack(event.target.value)}
              />
            </label>
          </div>

          {matchResult?.none && neighbors.length === 0 ? (
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
          {neighbors.length > 0 && (!matchResult || matchResult.exact.length === 0) ? (
            <p className="assistant-hint">
              Nearest neighbors:{" "}
              {neighbors
                .slice(0, 4)
                .map((n) => `${n.profile.id} (Δ${n.distance.toFixed(0)})`)
                .join(" · ")}
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
                  const near = neighbors.find((n) => n.profile.id === profile.id);
                  const synthetic =
                    profile.provenance.classification === "synthetic_fixture";
                  return (
                    <tr
                      key={catalogueRowKey(profile)}
                      data-selected={selectedId === profile.id ? "true" : undefined}
                      data-exact={exact ? "true" : undefined}
                      data-synthetic={synthetic ? "true" : undefined}
                    >
                      <td>
                        <div className="catalogue-name">{profile.displayName}</div>
                        <div className="catalogue-id tabular">{profile.id}</div>
                        {synthetic ? (
                          <div className="assistant-hint warn">synthetic demo — not GTO</div>
                        ) : null}
                        {alt ? (
                          <div className="assistant-hint">
                            alt: {alt.differences.join(", ")}
                          </div>
                        ) : null}
                        {near && !exact ? (
                          <div className="assistant-hint">
                            near Δ{near.distance.toFixed(1)}
                            {near.reasons.length ? `: ${near.reasons.join(", ")}` : ""}
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
