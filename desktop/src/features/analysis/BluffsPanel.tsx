import { useEffect, useMemo, useRef, useState } from "react";
import type { EquityHandRow } from "../../domain/analysis";
import { formatFrequencyPct } from "../../domain/betSizes";
import {
  formatEquityPct,
  formatEvChip,
  equityHandsForNode,
} from "../../domain/matrixDisplay";
import {
  DEFAULT_BLUFF_EQUITY_THRESHOLD,
  MIN_BET_FREQ,
  MIN_REACH_MASS,
  formatReachMass,
  listProminentBluffs,
  matrixCellForCombo,
  sortProminentBluffs,
  type BluffEquityMode,
  type BluffSortDir,
  type BluffSortKey,
} from "../../domain/prominentBluffs";
import { fetchPostCallEquityHands } from "../../domain/prominentBluffsPostCall";
import { engineClient } from "../../engine/client";
import { useSettingsStore } from "../../state/settingsStore";
import { useStudyStore } from "../../state/studyStore";

const DISPLAY_CAP = 50;

interface EquityPayload {
  pending?: boolean;
  oop_hands?: EquityHandRow[];
  ip_hands?: EquityHandRow[];
  node_id?: string;
}

interface PostCallCache {
  key: string;
  hands: EquityHandRow[];
  error: string | null;
}

const SORT_COLUMNS: Array<{ key: BluffSortKey; label: string }> = [
  { key: "combo", label: "Hand" },
  { key: "betFreq", label: "Bet %" },
  { key: "ev", label: "EV" },
  { key: "equity", label: "Eq" },
  { key: "reach", label: "Reach" },
  { key: "topBetAction", label: "Size" },
];

function clampThreshold(raw: number): number {
  if (!Number.isFinite(raw)) {
    return DEFAULT_BLUFF_EQUITY_THRESHOLD;
  }
  return Math.min(1, Math.max(0, raw));
}

function clampUnit(raw: number, fallback: number): number {
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, raw));
}

function postCallCacheKey(
  solutionId: string,
  nodeId: string,
  revision: number,
): string {
  return `${solutionId}|${nodeId}|${revision}`;
}

function SettingsGearIcon() {
  return (
    <svg
      className="bluffs-settings-icon"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="currentColor"
        d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.07 7.07 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.58.23-1.12.54-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.77 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.89 14.52a.5.5 0 0 0-.12.64l1.92 3.32c.14.24.43.34.68.22l2.39-.96c.5.4 1.05.71 1.63.94l.36 2.54c.05.24.25.42.5.42h3.84c.25 0 .45-.18.5-.42l.36-2.54c.58-.23 1.12-.54 1.63-.94l2.39.96c.25.12.54.02.68-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z"
      />
    </svg>
  );
}

function SortHeader({
  label,
  columnKey,
  sortKey,
  sortDir,
  onSort,
}: {
  label: string;
  columnKey: BluffSortKey;
  sortKey: BluffSortKey;
  sortDir: BluffSortDir;
  onSort: (key: BluffSortKey) => void;
}) {
  const active = sortKey === columnKey;
  const ariaSort = active
    ? sortDir === "asc"
      ? "ascending"
      : "descending"
    : "none";
  return (
    <th aria-sort={ariaSort}>
      <button
        type="button"
        className="bluffs-sort-btn"
        data-active={active ? "true" : "false"}
        onClick={() => onSort(columnKey)}
        aria-label={`Sort by ${label}${
          active ? ` (${sortDir === "asc" ? "ascending" : "descending"})` : ""
        }`}
      >
        <span>{label}</span>
        <span className="bluffs-sort-indicator" aria-hidden="true">
          {active ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </button>
    </th>
  );
}

/** Study lower-dock Bluffs tab — Mode A (node) and Mode B (after call). */
export function BluffsPanel() {
  const currentNode = useStudyStore((s) => s.currentNode);
  const equity = useStudyStore((s) => s.equity) as EquityPayload | null;
  const loadEquity = useStudyStore((s) => s.loadEquity);
  const nodeValues = useStudyStore((s) => s.nodeValues);
  const calculateEv = useStudyStore((s) => s.calculateEv);
  // Settings is the authority for local vs global EV display.
  const evDisplayBasis = useSettingsStore((s) => s.settings.evDisplayBasis);
  const setSelectedCell = useStudyStore((s) => s.setSelectedCell);
  const solutionId = useStudyStore((s) => s.solutionId);
  const status = useStudyStore((s) => s.status);

  const [thresholdPct, setThresholdPct] = useState(
    () => Math.round(DEFAULT_BLUFF_EQUITY_THRESHOLD * 100),
  );
  const [minBetPct, setMinBetPct] = useState(() =>
    Math.round(MIN_BET_FREQ * 100),
  );
  const [minReachMass, setMinReachMass] = useState(MIN_REACH_MASS);
  const [equityMode, setEquityMode] = useState<BluffEquityMode>("node");
  const [sortKey, setSortKey] = useState<BluffSortKey>("betFreq");
  const [sortDir, setSortDir] = useState<BluffSortDir>("desc");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [postCall, setPostCall] = useState<PostCallCache | null>(null);
  const [postCallPending, setPostCallPending] = useState(false);
  const [postCallMessage, setPostCallMessage] = useState<string | null>(null);
  const [postCallRefreshNonce, setPostCallRefreshNonce] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const cacheRef = useRef<PostCallCache | null>(null);
  const settingsRef = useRef<HTMLDivElement | null>(null);

  const threshold = clampThreshold(thresholdPct / 100);
  const minBetFreq = clampUnit(minBetPct / 100, MIN_BET_FREQ);
  const reachFloor = clampUnit(minReachMass, MIN_REACH_MASS);
  const equityPending = Boolean(equity?.pending);
  const equityReady = Boolean(equity && !equity.pending);
  const revision =
    typeof currentNode?.status_generation === "number"
      ? currentNode.status_generation
      : typeof status?.status_generation === "number"
        ? status.status_generation
        : 0;

  useEffect(() => {
    if (!solutionId || !currentNode) {
      return;
    }
    if (equityReady || equityPending) {
      return;
    }
    void loadEquity();
  }, [solutionId, currentNode, equityReady, equityPending, loadEquity]);

  const valuesPending = Boolean(nodeValues?.pending);
  const valuesReady = Boolean(nodeValues && !nodeValues.pending);
  const valuesForNode =
    valuesReady &&
    (!nodeValues?.node_id ||
      !currentNode?.node_id ||
      nodeValues.node_id === currentNode.node_id);

  // Load /values only after node equity is ready — explorer has one analysis
  // worker; concurrent equity+values polls can cancel each other forever.
  useEffect(() => {
    if (!solutionId || !currentNode) {
      return;
    }
    if (
      currentNode.kind === "chance" ||
      currentNode.kind === "terminal" ||
      !currentNode.actions?.length
    ) {
      return;
    }
    if (!equityReady) {
      return;
    }
    if (valuesReady || valuesPending) {
      return;
    }
    void calculateEv();
  }, [
    solutionId,
    currentNode,
    equityReady,
    valuesReady,
    valuesPending,
    calculateEv,
  ]);

  useEffect(() => {
    if (equityMode !== "after_call") {
      abortRef.current?.abort();
      abortRef.current = null;
      setPostCallPending(false);
      return;
    }
    if (!solutionId || !currentNode) {
      return;
    }
    if (
      currentNode.kind === "chance" ||
      currentNode.kind === "terminal" ||
      !currentNode.actions?.length
    ) {
      return;
    }

    const key = postCallCacheKey(solutionId, currentNode.node_id, revision);
    if (cacheRef.current?.key === key) {
      setPostCall(cacheRef.current);
      setPostCallMessage(cacheRef.current.error);
      setPostCallPending(false);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPostCallPending(true);
    setPostCallMessage(null);

    const nodeSnapshot = currentNode;

    void (async () => {
      try {
        const result = await fetchPostCallEquityHands({
          solutionId,
          node: nodeSnapshot,
          heroPlayer: nodeSnapshot.player,
          signal: controller.signal,
          deps: {
            getNode: (sid, nid, signal) => engineClient.getNode(sid, nid, signal),
            getEquity: (sid, nid, signal) =>
              engineClient.getEquity(sid, nid, signal),
          },
        });
        if (controller.signal.aborted) {
          return;
        }
        const live = useStudyStore.getState().currentNode;
        if (!live || live.node_id !== nodeSnapshot.node_id) {
          return;
        }
        const cached: PostCallCache = {
          key,
          hands: result.hands,
          error: result.error,
        };
        cacheRef.current = cached;
        setPostCall(cached);
        setPostCallMessage(result.error);
        setPostCallPending(false);
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        setPostCall(null);
        setPostCallMessage(
          error instanceof Error
            ? error.message
            : "Failed to load post-call equity",
        );
        setPostCallPending(false);
      }
    })();

    return () => {
      controller.abort();
    };
  }, [equityMode, solutionId, currentNode, revision, postCallRefreshNonce]);

  useEffect(() => {
    if (!settingsOpen) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      const root = settingsRef.current;
      if (!root || root.contains(event.target as Node)) {
        return;
      }
      setSettingsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSettingsOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [settingsOpen]);

  const expectedPostCallKey =
    solutionId && currentNode
      ? postCallCacheKey(solutionId, currentNode.node_id, revision)
      : "";

  const equityHands = useMemo(() => {
    if (equityMode === "after_call") {
      return postCall?.key === expectedPostCallKey ? postCall.hands : null;
    }
    return equityHandsForNode(equity, currentNode?.player) as EquityHandRow[] | null;
  }, [equityMode, postCall, expectedPostCallKey, equity, currentNode?.player]);

  const rows = useMemo(() => {
    if (equityMode === "after_call" && (postCallPending || !equityHands)) {
      return [];
    }
    const listed = listProminentBluffs({
      node: currentNode,
      equityHands,
      threshold,
      equityMode,
      minBetFreq,
      minReachMass: reachFloor,
      nodeValues: valuesForNode ? nodeValues : null,
      evDisplayBasis,
    });
    return sortProminentBluffs(listed, sortKey, sortDir);
  }, [
    currentNode,
    equityHands,
    threshold,
    equityMode,
    postCallPending,
    valuesForNode,
    nodeValues,
    evDisplayBasis,
    minBetFreq,
    reachFloor,
    sortKey,
    sortDir,
  ]);

  const visible = rows.slice(0, DISPLAY_CAP);
  const thresholdLabel = `${Math.round(threshold * 100)}%`;
  const betFloorLabel = `${Math.round(minBetFreq * 1000) / 10}%`;
  const reachFloorLabel = reachFloor.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  const modeLabel = equityMode === "after_call" ? "after call" : "at this node";

  const onRowActivate = (combo: string) => {
    const cell = matrixCellForCombo(combo);
    if (!cell) {
      return;
    }
    setSelectedCell(cell);
  };

  const onRefresh = () => {
    if (equityMode === "after_call") {
      cacheRef.current = null;
      setPostCall(null);
      setPostCallRefreshNonce((value) => value + 1);
      return;
    }
    void loadEquity();
  };

  const onSort = (key: BluffSortKey) => {
    if (key === sortKey) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDir(key === "combo" || key === "topBetAction" ? "asc" : "desc");
  };

  const resetViewerSettings = () => {
    setMinBetPct(Math.round(MIN_BET_FREQ * 100));
    setMinReachMass(MIN_REACH_MASS);
    setSortKey("betFreq");
    setSortDir("desc");
  };

  return (
    <div className="range-explorer">
      <div className="panel-title-row">
        <h2 className="panel-title">Prominent bluffs</h2>
        <div className="panel-title-actions">
          <button
            type="button"
            className="toolbar-btn"
            disabled={!solutionId || !currentNode}
            onClick={onRefresh}
          >
            Refresh
          </button>
          <div className="bluffs-settings" ref={settingsRef}>
            <button
              type="button"
              className="toolbar-btn bluffs-settings-toggle"
              aria-label="Bluff viewer settings"
              aria-haspopup="menu"
              aria-expanded={settingsOpen}
              title="Bluff viewer settings"
              onClick={() => setSettingsOpen((open) => !open)}
            >
              <SettingsGearIcon />
            </button>
            {settingsOpen ? (
              <div className="bluffs-settings-menu" role="menu" aria-label="Bluff viewer settings">
                <label className="bluffs-settings-field">
                  <span>Min bet %</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={0.1}
                    value={minBetPct}
                    aria-label="Minimum bet frequency percent"
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      if (!Number.isFinite(next)) {
                        return;
                      }
                      setMinBetPct(Math.min(100, Math.max(0, next)));
                    }}
                  />
                </label>
                <label className="bluffs-settings-field">
                  <span>Min reach</span>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.001}
                    value={minReachMass}
                    aria-label="Minimum reach mass"
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      if (!Number.isFinite(next)) {
                        return;
                      }
                      setMinReachMass(Math.min(1, Math.max(0, next)));
                    }}
                  />
                </label>
                <p className="bluffs-settings-hint muted">
                  Click column headers to sort ascending/descending. Equity
                  threshold stays in the toolbar above.
                </p>
                <button
                  type="button"
                  className="toolbar-btn"
                  role="menuitem"
                  onClick={() => {
                    resetViewerSettings();
                    setSettingsOpen(false);
                  }}
                >
                  Reset defaults
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="bluffs-controls">
        <label className="bluffs-control">
          <span className="muted">Equity &lt;</span>
          <input
            type="number"
            className="bluffs-threshold"
            min={0}
            max={100}
            step={1}
            value={thresholdPct}
            aria-label="Equity threshold percent"
            onChange={(event) => {
              const next = Number(event.target.value);
              if (!Number.isFinite(next)) {
                return;
              }
              setThresholdPct(Math.min(100, Math.max(0, Math.round(next))));
            }}
          />
          <span className="muted">%</span>
        </label>
        <div className="seat-toggle" role="group" aria-label="Bluff equity mode">
          <button
            type="button"
            className="toolbar-btn"
            aria-pressed={equityMode === "node"}
            onClick={() => setEquityMode("node")}
          >
            At this node
          </button>
          <button
            type="button"
            className="toolbar-btn"
            aria-pressed={equityMode === "after_call"}
            title="Check-down equity on the Call child after the dominant bet/raise"
            onClick={() => setEquityMode("after_call")}
          >
            After call
          </button>
        </div>
      </div>

      <p className="equity-note muted">
        Check-down equity &lt; {thresholdLabel} ({modeLabel}); bet/raise/all-in ≥{" "}
        {betFloorLabel}; reach ≥ {reachFloorLabel}
        {equityMode === "after_call"
          ? "; each hand uses its highest-frequency bet/raise size"
          : ""}
        .
      </p>

      {!currentNode ? (
        <p className="empty-hint">Browse a decision node after a solve.</p>
      ) : currentNode.kind === "chance" || currentNode.kind === "terminal" ? (
        <p className="empty-hint">Bluffs need a decision node (bet or raise).</p>
      ) : equityMode === "node" && !equity ? (
        <p className="empty-hint">Click Refresh to load equity.</p>
      ) : equityMode === "node" && equity?.pending ? (
        <p className="empty-hint">Loading…</p>
      ) : equityMode === "after_call" && postCallPending ? (
        <p className="empty-hint">Loading post-call equity…</p>
      ) : equityMode === "after_call" && postCallMessage && !visible.length ? (
        <p className="empty-hint">{postCallMessage}</p>
      ) : !visible.length ? (
        <p className="empty-hint">
          No bluffs with bet ≥ {betFloorLabel}, reach ≥ {reachFloorLabel}, and
          equity &lt; {thresholdLabel} ({modeLabel}).
        </p>
      ) : (
        <>
          {postCallMessage && equityMode === "after_call" ? (
            <p className="equity-note muted">{postCallMessage}</p>
          ) : null}
          {rows.length > DISPLAY_CAP ? (
            <p className="equity-note muted">
              Showing {DISPLAY_CAP} of {rows.length}
            </p>
          ) : null}
          <table className="data-table">
            <thead>
              <tr>
                {SORT_COLUMNS.map((column) => (
                  <SortHeader
                    key={column.key}
                    label={column.label}
                    columnKey={column.key}
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onSort={onSort}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr
                  key={row.combo}
                  className="bluffs-row"
                  tabIndex={0}
                  role="button"
                  aria-label={`Select ${row.combo} on the matrix`}
                  onClick={() => onRowActivate(row.combo)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onRowActivate(row.combo);
                    }
                  }}
                >
                  <td>{row.combo}</td>
                  <td className="tabular">
                    {formatFrequencyPct(row.betFreq) ?? "—"}
                  </td>
                  <td className="tabular">{formatEvChip(row.ev)}</td>
                  <td className="tabular">{formatEquityPct(row.equity)}</td>
                  <td className="tabular">{formatReachMass(row.reach)}</td>
                  <td>{row.topBetAction ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
