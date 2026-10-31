import { useStudyStore } from "../../state/studyStore";

export function SolveControls() {
  const phase = useStudyStore((s) => s.phase);
  const solve = useStudyStore((s) => s.solve);
  const continueSolve = useStudyStore((s) => s.continueSolve);
  const pause = useStudyStore((s) => s.pause);
  const stop = useStudyStore((s) => s.stop);
  const calculateEv = useStudyStore((s) => s.calculateEv);
  const saveSolution = useStudyStore((s) => s.saveSolution);
  const openSolution = useStudyStore((s) => s.openSolution);

  const busy = phase === "solving" || phase === "building";
  const canContinue = phase === "paused" || phase === "complete" || phase === "stop_requested";

  return (
    <div className="solve-controls">
      <button type="button" className="toolbar-btn primary" onClick={() => void solve()}>
        Solve
      </button>
      <button
        type="button"
        className="toolbar-btn"
        disabled={!canContinue && !busy}
        onClick={() => void continueSolve()}
      >
        Continue
      </button>
      <button type="button" className="toolbar-btn" disabled={!busy} onClick={() => void pause()}>
        Pause
      </button>
      <button
        type="button"
        className="toolbar-btn danger"
        disabled={!busy && phase !== "pause_requested"}
        onClick={() => void stop()}
      >
        Stop
      </button>
      <button type="button" className="toolbar-btn" onClick={() => void calculateEv()}>
        EV
      </button>
      <button type="button" className="toolbar-btn" onClick={() => void saveSolution()}>
        Save
      </button>
      <button type="button" className="toolbar-btn" onClick={() => void openSolution()}>
        Open
      </button>
    </div>
  );
}
