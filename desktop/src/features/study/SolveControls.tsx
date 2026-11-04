import {
  canExecuteCalculateEv,
  canExecuteContinue,
  canExecutePause,
  canExecuteSave,
  canExecuteSolve,
  canExecuteStop,
  executeCalculateEv,
  executeContinue,
  executePause,
  executeSave,
  executeSolve,
  executeStop,
  studyCommandContextFromStore,
} from "../../commands/studyCommands";
import { openSolutionFile, saveSolutionFile } from "../../commands/solutionFiles";
import { useStudyStore } from "../../state/studyStore";

export function SolveControls() {
  const phase = useStudyStore((s) => s.phase);
  const solutionId = useStudyStore((s) => s.solutionId);
  const draft = useStudyStore((s) => s.draft);
  const workspace = useStudyStore((s) => s.workspace);
  const currentNode = useStudyStore((s) => s.currentNode);
  const solveValidationErrors = useStudyStore((s) => s.solveValidationErrors);
  const solve = useStudyStore((s) => s.solve);
  const continueSolve = useStudyStore((s) => s.continueSolve);
  const pause = useStudyStore((s) => s.pause);
  const stop = useStudyStore((s) => s.stop);
  const calculateEv = useStudyStore((s) => s.calculateEv);
  const saveSolution = useStudyStore((s) => s.saveSolution);
  const openSolution = useStudyStore((s) => s.openSolution);
  const updateDraft = useStudyStore((s) => s.updateDraft);

  const ctx = studyCommandContextFromStore({
    phase,
    draft,
    solutionId,
    workspace,
    currentNode,
    solveValidationErrors,
  });
  const solveGate = canExecuteSolve(ctx);
  const continueGate = canExecuteContinue(ctx);
  const pauseGate = canExecutePause(ctx);
  const stopGate = canExecuteStop(ctx);
  const evGate = canExecuteCalculateEv(ctx);
  const saveGate = canExecuteSave(ctx);

  function commandDeps() {
    return {
      getContext: () => studyCommandContextFromStore(useStudyStore.getState()),
    };
  }

  function solutionFileDeps() {
    return {
      getSolutionPath: () => useStudyStore.getState().draft.solutionPath,
      updateDraft,
      openSolution,
      saveSolution,
    };
  }

  return (
    <div className="solve-controls" role="group" aria-label="Solve controls">
      <button
        type="button"
        className="toolbar-btn primary"
        disabled={!solveGate.ok}
        title={solveGate.reason}
        onClick={() =>
          void executeSolve({
            ...commandDeps(),
            solve,
          })
        }
      >
        Solve
      </button>
      <button
        type="button"
        className="toolbar-btn"
        disabled={!continueGate.ok}
        title={continueGate.reason}
        onClick={() =>
          void executeContinue({
            ...commandDeps(),
            continueSolve,
          })
        }
      >
        Continue
      </button>
      <button
        type="button"
        className="toolbar-btn"
        disabled={!pauseGate.ok}
        title={pauseGate.reason}
        onClick={() =>
          void executePause({
            ...commandDeps(),
            pause,
          })
        }
      >
        Pause
      </button>
      <button
        type="button"
        className="toolbar-btn danger"
        disabled={!stopGate.ok}
        title={stopGate.reason}
        onClick={() =>
          void executeStop({
            ...commandDeps(),
            stop,
          })
        }
      >
        Stop
      </button>
      <button
        type="button"
        className="toolbar-btn"
        disabled={!evGate.ok}
        title={evGate.reason}
        onClick={() =>
          void executeCalculateEv({
            ...commandDeps(),
            calculateEv,
          })
        }
      >
        EV
      </button>
      <button
        type="button"
        className="toolbar-btn"
        disabled={!saveGate.ok}
        title={saveGate.reason}
        onClick={() =>
          void executeSave({
            ...commandDeps(),
            save: async () => {
              await saveSolutionFile(solutionFileDeps());
            },
          })
        }
      >
        Save
      </button>
      <button
        type="button"
        className="toolbar-btn"
        onClick={() => void openSolutionFile(solutionFileDeps())}
      >
        Open
      </button>
    </div>
  );
}
