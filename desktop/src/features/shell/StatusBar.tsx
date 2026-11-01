import {
  engineActivityMessage,
  phaseLabel,
  statusMetrics,
} from "../../domain/solveActivity";
import type { SolvePhase, StatusPayload } from "../../domain/types";

export type ConnectionState = "connected" | "disconnected" | "connecting";

interface Props {
  message: string;
  connection: ConnectionState;
  phase: SolvePhase;
  status?: StatusPayload | null;
  onReconnect?: () => void;
}

export function StatusBar({ message, connection, phase, status, onReconnect }: Props) {
  const activity = engineActivityMessage(phase, status, message);
  const metrics = statusMetrics(status);
  const live =
    phase === "solving" ||
    phase === "building" ||
    phase === "pause_requested" ||
    phase === "stop_requested";

  return (
    <footer className="status-bar" role="status" aria-live="polite">
      <span className="status-dot" data-state={connection} title={connection} />
      <span
        className="status-bar__phase"
        data-phase={phase}
        data-live={live ? "true" : "false"}
        title={`Engine phase: ${phase}`}
      >
        {phaseLabel(phase)}
      </span>
      <span className="status-bar__msg" title={activity}>
        {activity || "Ready"}
      </span>
      {connection === "disconnected" && onReconnect ? (
        <button type="button" className="toolbar-btn" onClick={onReconnect}>
          Reconnect
        </button>
      ) : null}
      <span className="status-bar__metrics tabular" aria-label="Solve metrics">
        <span title="Completed / requested iterations">
          Iter {metrics.iterations}
          {metrics.target !== "—" ? `/${metrics.target}` : ""}
        </span>
        <span title="Elapsed solve time">Time {metrics.runtime}</span>
        <span title="Iterations per second">Rate {metrics.rate}</span>
        <span title="Root OOP EV (chips)">EV {metrics.ev}</span>
        <span title="NashConv (absolute and % of pot)">Nash {metrics.nash}</span>
        <span title="Engine-allocated heap">Mem {metrics.memory}</span>
      </span>
    </footer>
  );
}
