/**
 * River beta chrome: live-solving label, bounds, metrics, reconnect.
 */
import { useEffect, useSyncExternalStore } from "react";
import { useStudyStore } from "../state/studyStore";
import {
  getActiveRiverBetaConfig,
  reconnectRiverBeta,
  refreshRiverBetaMetrics,
  riverBetaCancel,
  riverBetaResolve,
  riverBetaResolveDefault,
  subscribeRiverBetaMode,
  type RiverBetaBootConfig,
} from "./riverBetaMode";

function useRiverBetaConfig(): RiverBetaBootConfig | null {
  return useSyncExternalStore(
    subscribeRiverBetaMode,
    getActiveRiverBetaConfig,
    () => null,
  );
}

function formatBytes(n: number | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatIdle(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  if (sec >= 120) return `${Math.round(sec / 60)}m`;
  return `${Math.max(0, Math.round(sec))}s`;
}

function boundsHint(config: RiverBetaBootConfig): string {
  const b = config.bounds;
  if (b?.summary) return b.summary;
  if (!b) return "Turn/flop out of scope · isolated session · Zig typed IPC";
  const parts: string[] = ["river only"];
  if (b.max_iterations != null) parts.push(`≤${b.max_iterations} iters`);
  if (b.max_time_limit_sec != null) parts.push(`≤${b.max_time_limit_sec}s`);
  if (b.max_memory_mib != null) parts.push(`≤${b.max_memory_mib} MiB`);
  if (b.max_weighted_combos_per_player != null) {
    parts.push(`≤${b.max_weighted_combos_per_player} combos`);
  }
  if (b.max_session_idle_sec != null) {
    parts.push(`idle ${b.max_session_idle_sec}s`);
  }
  return parts.join(" · ");
}

export function RiverBetaBanner() {
  const config = useRiverBetaConfig();
  const phase = useStudyStore((s) => s.phase);
  const status = useStudyStore((s) => s.status);
  const startPolling = useStudyStore((s) => s.startPolling);
  const recoverEngineSession = useStudyStore((s) => s.recoverEngineSession);

  useEffect(() => {
    if (!config) return;
    const id = window.setInterval(() => {
      void refreshRiverBetaMetrics();
    }, 2000);
    return () => window.clearInterval(id);
  }, [config]);

  if (!config) return null;

  const metrics = config.metrics;
  const connected = config.connectionState === "connected";
  const busy =
    config.connectionState === "reconnecting" ||
    Boolean(status?.running) ||
    phase === "solving";
  const iterations =
    typeof status?.iterations === "number" ? status.iterations : null;
  const iterationsRequested =
    typeof status?.iterations_requested === "number"
      ? status.iterations_requested
      : null;

  const stateLabel =
    config.connectionState === "connected"
      ? "Live solving · river only"
      : config.connectionState === "reconnecting"
        ? "Reconnecting…"
        : config.connectionState === "lost"
          ? "Session lost"
          : "Service unavailable";

  return (
    <div
      className={`river-beta-banner${
        connected ? "" : " river-beta-banner--degraded"
      }`}
      role="region"
      aria-label="River beta"
    >
      <div className="river-beta-banner__meta">
        <strong className="river-beta-banner__title">River beta</strong>
        <span className="river-beta-banner__badge">{stateLabel}</span>
        <span className="river-beta-banner__hint">{boundsHint(config)}</span>
        {config.lastError ? (
          <span className="river-beta-banner__error" role="status">
            {config.lastError}
          </span>
        ) : null}
      </div>
      <div className="river-beta-banner__metrics" aria-label="Session metrics">
        <span>CPU {metrics?.cpu_total_sec?.toFixed(2) ?? "—"}s</span>
        <span>Peak RSS {formatBytes(metrics?.peak_rss_bytes)}</span>
        <span>Solves {metrics?.solve_count ?? 0}</span>
        <span>Idle left {formatIdle(config.idleRemainingSec)}</span>
        {busy && iterations != null ? (
          <span>
            Iters {iterations}
            {iterationsRequested != null ? `/${iterationsRequested}` : ""}
          </span>
        ) : null}
      </div>
      <div className="river-beta-banner__controls">
        {connected ? (
          <>
            <button
              type="button"
              className="river-beta-banner__btn"
              disabled={busy}
              onClick={() => {
                void (async () => {
                  await riverBetaResolveDefault();
                  startPolling();
                  await recoverEngineSession();
                })();
              }}
            >
              Solve
            </button>
            <button
              type="button"
              className="river-beta-banner__btn"
              disabled={!busy}
              onClick={() => {
                void riverBetaCancel();
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="river-beta-banner__btn"
              disabled={busy}
              onClick={() => {
                void (async () => {
                  await riverBetaResolve({});
                  startPolling();
                  await recoverEngineSession();
                })();
              }}
            >
              Re-solve locks
            </button>
          </>
        ) : (
          <button
            type="button"
            className="river-beta-banner__btn river-beta-banner__btn--primary"
            disabled={config.connectionState === "reconnecting"}
            onClick={() => {
              void (async () => {
                try {
                  await reconnectRiverBeta({ autoSolve: true });
                  startPolling();
                  await recoverEngineSession();
                } catch {
                  /* banner shows lastError */
                }
              })();
            }}
          >
            {config.connectionState === "reconnecting"
              ? "Reconnecting…"
              : "Reconnect"}
          </button>
        )}
      </div>
    </div>
  );
}
