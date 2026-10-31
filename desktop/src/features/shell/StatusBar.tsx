import type { SolvePhase } from "../../domain/types";

export type ConnectionState = "connected" | "disconnected" | "connecting";

interface Props {
  message: string;
  connection: ConnectionState;
  phase: SolvePhase;
  iterations?: number | null;
  nashGap?: number | null;
  pot?: number | null;
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

export function StatusBar({
  message,
  connection,
  phase,
  iterations,
  nashGap,
  pot,
  onReconnect,
}: Props) {
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
      <span>Iter {iterations ?? "—"}</span>
      <span>Nash {formatGap(nashGap, pot)}</span>
    </footer>
  );
}
