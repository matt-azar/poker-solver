import { statusRootEv } from "../../domain/status";
import type { SolvePhase, StatusPayload } from "../../domain/types";

export type ConnectionState = "connected" | "disconnected" | "connecting";

interface Props {
  message: string;
  connection: ConnectionState;
  phase: SolvePhase;
  status?: StatusPayload | null;
  onReconnect?: () => void;
}

function formatGap(gap: number | null | undefined, pot: number | null | undefined): string {
  if (gap == null || Number.isNaN(gap)) {
    return "—";
  }
  const abs = gap.toFixed(3);
  if (pot && pot > 0) {
    return `${abs} (${((gap / pot) * 100).toFixed(2)}% pot)`;
  }
  return abs;
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !(bytes > 0)) {
    return "—";
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function StatusBar({ message, connection, phase, status, onReconnect }: Props) {
  const ev = statusRootEv(status);
  return (
    <footer className="status-bar" role="status">
      <span className="status-dot" data-state={connection} title={connection} />
      <span className="status-bar__msg">{message || "Ready"}</span>
      {connection === "disconnected" && onReconnect ? (
        <button type="button" className="toolbar-btn" onClick={onReconnect}>
          Reconnect
        </button>
      ) : null}
      <span>Phase {phase}</span>
      <span>Iter {status?.iterations ?? "—"}</span>
      <span className="tabular">
        EV {ev == null ? "—" : ev.toFixed(3)}
      </span>
      <span>Nash {formatGap(status?.nash_gap, status?.pot)}</span>
      <span title="engine_allocated">
        Mem {formatBytes(status?.engine_allocated ?? status?.engine_heap_bytes)}
      </span>
    </footer>
  );
}
