/**
 * River beta chrome: live-solving label, metrics, cancel / re-solve.
 */
import { useEffect, useSyncExternalStore } from "react";
import { useStudyStore } from "../state/studyStore";
import {
  getActiveRiverBetaConfig,
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
  const running = Boolean(status?.running) || phase === "solving";

  return (
    <div className="river-beta-banner" role="region" aria-label="River beta">
      <div className="river-beta-banner__meta">
        <strong className="river-beta-banner__title">River beta</strong>
        <span className="river-beta-banner__badge">Live solving · river only</span>
        <span className="river-beta-banner__hint">
          Turn/flop out of scope · isolated session · Zig typed IPC
        </span>
      </div>
      <div className="river-beta-banner__metrics" aria-label="Session metrics">
        <span>CPU {metrics?.cpu_total_sec?.toFixed(2) ?? "—"}s</span>
        <span>Peak RSS {formatBytes(metrics?.peak_rss_bytes)}</span>
        <span>Solves {metrics?.solve_count ?? 0}</span>
      </div>
      <div className="river-beta-banner__controls">
        <button
          type="button"
          className="river-beta-banner__btn"
          disabled={running}
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
          disabled={!running}
          onClick={() => {
            void riverBetaCancel();
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          className="river-beta-banner__btn"
          disabled={running}
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
      </div>
    </div>
  );
}
