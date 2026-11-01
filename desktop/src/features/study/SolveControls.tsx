import { solveControlFlags } from "../../domain/solveControls";
import { useStudyStore } from "../../state/studyStore";

export function SolveControls() {
  const phase = useStudyStore((s) => s.phase);
  const solutionId = useStudyStore((s) => s.solutionId);
  const solve = useStudyStore((s) => s.solve);
  const continueSolve = useStudyStore((s) => s.continueSolve);
  const pause = useStudyStore((s) => s.pause);
  const stop = useStudyStore((s) => s.stop);
  const calculateEv = useStudyStore((s) => s.calculateEv);
  const saveSolution = useStudyStore((s) => s.saveSolution);
  const openSolution = useStudyStore((s) => s.openSolution);

  const { canSolve, canContinue, canPause, canStop } = solveControlFlags(phase);
  const hasSolution = Boolean(solutionId);

  return (
    <div className="solve-controls" role="group" aria-label="Solve controls">
      <button
        type="button"
        className="toolbar-btn primary"
        disabled={!canSolve}
        title={
          canSolve
            ? "Start a new solve from the current build settings"
            : "Stop or wait for the current solve before starting another"
        }
        onClick={() => void solve()}
      >
        Solve
      </button>
      <button
        type="button"
        className="toolbar-btn"
        disabled={!canContinue}
        title={
          canContinue
            ? "Resume or add iterations to the current solution"
            : "Continue is available after Pause, Stop, or Complete"
        }
        onClick={() => void continueSolve()}
      >
        Continue
      </button>
      <button
        type="button"
        className="toolbar-btn"
        disabled={!canPause}
        title={canPause ? "Pause after the current sample" : "Nothing is solving"}
        onClick={() => void pause()}
      >
        Pause
      </button>
      <button
        type="button"
        className="toolbar-btn danger"
        disabled={!canStop}
        title={canStop ? "Stop and keep completed iterations" : "Nothing is solving"}
        onClick={() => void stop()}
      >
        Stop
      </button>
      <button
        type="button"
        className="toolbar-btn"
        disabled={!hasSolution}
        title={hasSolution ? "Compute action EVs for the current node" : "Solve first"}
        onClick={() => void calculateEv()}
      >
        EV
      </button>
      <button
        type="button"
        className="toolbar-btn"
        disabled={!hasSolution}
        title={hasSolution ? "Save the current solution" : "Solve first"}
        onClick={() => void saveSolution()}
      >
        Save
      </button>
      <button type="button" className="toolbar-btn" onClick={() => void openSolution()}>
        Open
      </button>
    </div>
  );
}
