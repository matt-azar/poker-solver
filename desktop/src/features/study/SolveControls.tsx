import {
  canExecuteSave,
  executeSave,
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
    <div className="solve-controls" role="group" aria-label="Solution files">
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
