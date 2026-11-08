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
  listProminentBluffs,
  matrixCellForCombo,
  type BluffEquityMode,
} from "../../domain/prominentBluffs";
import { fetchPostCallEquityHands } from "../../domain/prominentBluffsPostCall";
import { engineClient } from "../../engine/client";
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

function clampThreshold(raw: number): number {
  if (!Number.isFinite(raw)) {
    return DEFAULT_BLUFF_EQUITY_THRESHOLD;
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

/** Study lower-dock Bluffs tab — Mode A (node) and Mode B (after call). */
export function BluffsPanel() {
  const currentNode = useStudyStore((s) => s.currentNode);
  const equity = useStudyStore((s) => s.equity) as EquityPayload | null;
  const loadEquity = useStudyStore((s) => s.loadEquity);
  const nodeValues = useStudyStore((s) => s.nodeValues);
  const calculateEv = useStudyStore((s) => s.calculateEv);
  const evDisplayBasis = useStudyStore((s) => s.evDisplayBasis);
  const setSelectedCell = useStudyStore((s) => s.setSelectedCell);
  const solutionId = useStudyStore((s) => s.solutionId);
  const status = useStudyStore((s) => s.status);

  const [thresholdPct, setThresholdPct] = useState(
    () => Math.round(DEFAULT_BLUFF_EQUITY_THRESHOLD * 100),
  );
  const [equityMode, setEquityMode] = useState<BluffEquityMode>("node");
  const [postCall, setPostCall] = useState<PostCallCache | null>(null);
  const [postCallPending, setPostCallPending] = useState(false);
  const [postCallMessage, setPostCallMessage] = useState<string | null>(null);
  const [postCallRefreshNonce, setPostCallRefreshNonce] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const cacheRef = useRef<PostCallCache | null>(null);

  const threshold = clampThreshold(thresholdPct / 100);
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
    if (valuesReady || valuesPending) {
      return;
    }
    void calculateEv();
  }, [
    solutionId,
    currentNode,
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
    return listProminentBluffs({
      node: currentNode,
      equityHands,
      threshold,
      equityMode,
      minBetFreq: MIN_BET_FREQ,
      nodeValues: valuesForNode ? nodeValues : null,
      evDisplayBasis,
    });
  }, [
    currentNode,
    equityHands,
    threshold,
    equityMode,
    postCallPending,
    valuesForNode,
    nodeValues,
    evDisplayBasis,
  ]);

  const visible = rows.slice(0, DISPLAY_CAP);
  const thresholdLabel = `${Math.round(threshold * 100)}%`;
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
        Check-down equity &lt; {thresholdLabel} ({modeLabel}); bet/raise/all-in ≥
        1%; sorted by bet frequency
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
          No bluffs with bet ≥ 1% and equity &lt; {thresholdLabel} ({modeLabel}).
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
                <th>Hand</th>
                <th>Bet %</th>
                <th>EV</th>
                <th>Eq</th>
                <th>Size</th>
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
