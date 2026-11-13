import {
  canExecuteContinue,
  canExecutePause,
  canExecuteSolve,
  canExecuteStop,
  executeContinue,
  executePause,
  executeSolve,
  executeStop,
  studyCommandContextFromStore,
} from "../../commands/studyCommands";
import { canOfferReopenLastCheckpoint } from "../../domain/sessionRecovery";
import {
  engineActivityMessage,
  phaseLabel,
  statusMetrics,
} from "../../domain/solveActivity";
import type { SolvePhase, StatusPayload } from "../../domain/types";
import { useStudyStore } from "../../state/studyStore";

export type ConnectionState = "connected" | "disconnected" | "connecting";

interface Props {
  message: string;
  connection: ConnectionState;
  phase: SolvePhase;
  status?: StatusPayload | null;
  onReconnect?: () => void;
  onReopenLastCheckpoint?: () => void;
}

export function StatusBar({
  message,
  connection,
  phase,
  status,
  onReconnect,
  onReopenLastCheckpoint,
}: Props) {
  const activity = engineActivityMessage(phase, status, message);
  const metrics = statusMetrics(status);
  const solve = useStudyStore((s) => s.solve);
  const pause = useStudyStore((s) => s.pause);
  const stop = useStudyStore((s) => s.stop);
  const continueSolve = useStudyStore((s) => s.continueSolve);
  const draft = useStudyStore((s) => s.draft);
  const lastCheckpointPath = useStudyStore((s) => s.lastCheckpointPath);
  const solutionId = useStudyStore((s) => s.solutionId);
  const workspace = useStudyStore((s) => s.workspace);
  const currentNode = useStudyStore((s) => s.currentNode);
  const solveValidationErrors = useStudyStore((s) => s.solveValidationErrors);
  const checkpointPath = lastCheckpointPath.trim();
  const showReopen =
    Boolean(onReopenLastCheckpoint) &&
    canOfferReopenLastCheckpoint(checkpointPath) &&
    (connection === "disconnected" || !solutionId);

  const commandCtx = studyCommandContextFromStore({
    phase,
    draft,
    solutionId,
    workspace,
    currentNode,
    solveValidationErrors,
    status: status ?? null,
  });
  const solveGate = canExecuteSolve(commandCtx);
  const continueGate = canExecuteContinue(commandCtx);
  const pauseGate = canExecutePause(commandCtx);
  const stopGate = canExecuteStop(commandCtx);

  function commandDeps() {
    return {
      getContext: () =>
        studyCommandContextFromStore({
          ...useStudyStore.getState(),
          status: useStudyStore.getState().status,
        }),
    };
  }

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
      <div className="status-bar__controls" role="group" aria-label="Solve controls">
        <button
          type="button"
          className="toolbar-btn primary"
          disabled={!solveGate.ok}
          title={solveGate.reason}
          onClick={() => void executeSolve({ ...commandDeps(), solve })}
        >
          Solve
        </button>
        <button
          type="button"
          className="toolbar-btn"
          disabled={!continueGate.ok}
          title={continueGate.reason}
          onClick={() =>
            void executeContinue({ ...commandDeps(), continueSolve })
          }
        >
          Continue
        </button>
        <button
          type="button"
          className="toolbar-btn"
          disabled={!pauseGate.ok}
          title={pauseGate.reason}
          onClick={() => void executePause({ ...commandDeps(), pause })}
        >
          Pause
        </button>
        <button
          type="button"
          className="toolbar-btn danger"
          disabled={!stopGate.ok}
          title={stopGate.reason}
          onClick={() => void executeStop({ ...commandDeps(), stop })}
        >
          Stop
        </button>
      </div>
      <span className="status-bar__msg" title={activity}>
        {activity || "Ready"}
      </span>
      {connection === "disconnected" && onReconnect ? (
        <button type="button" className="toolbar-btn" onClick={onReconnect}>
          Reconnect
        </button>
      ) : null}
      {showReopen ? (
        <button
          type="button"
          className="toolbar-btn"
          title={`Reopen last checkpoint (${checkpointPath})`}
          onClick={onReopenLastCheckpoint}
        >
          Reopen last checkpoint
        </button>
      ) : null}
      <span className="status-bar__metrics tabular" aria-label="Solve metrics">
        <span title="Completed / requested iterations">
          Iter {metrics.iterations}
          {metrics.target !== "—" ? `/${metrics.target}` : ""}
        </span>
        <span title="Active engine job id">Job {metrics.job}</span>
        <span title="Elapsed solve time">Time {metrics.runtime}</span>
        <span title="Estimated time to stop criterion (iterations or accuracy)">
          ETA {metrics.eta}
        </span>
        <span title="Iterations per second">Rate {metrics.rate}</span>
        <span title="Root OOP EV (chips)">EV {metrics.ev}</span>
        <span title="Pio Accuracy (NashConv/2) in chips and % of pot">
          Acc {metrics.nash}
        </span>
        <span title="Engine-allocated heap">Mem {metrics.memory}</span>
      </span>
    </footer>
  );
}
