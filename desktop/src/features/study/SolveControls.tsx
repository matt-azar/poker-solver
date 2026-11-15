import {
  canExecuteSave,
  executeSave,
  studyCommandContextFromStore,
} from "../../commands/studyCommands";
import { useSolutionsCatalogueUi } from "../../state/solutionsCatalogueUi";
import { useStudyStore } from "../../state/studyStore";

export function SolveControls() {
  const phase = useStudyStore((s) => s.phase);
  const solutionId = useStudyStore((s) => s.solutionId);
  const draft = useStudyStore((s) => s.draft);
  const status = useStudyStore((s) => s.status);
  const workspace = useStudyStore((s) => s.workspace);
  const currentNode = useStudyStore((s) => s.currentNode);
  const solveValidationErrors = useStudyStore((s) => s.solveValidationErrors);
  const saveSolution = useStudyStore((s) => s.saveSolution);
  const openCatalogue = useSolutionsCatalogueUi((s) => s.openCatalogue);

  const ctx = studyCommandContextFromStore({
    phase,
    draft,
    solutionId,
    workspace,
    currentNode,
    solveValidationErrors,
    status,
  });
  const saveGate = canExecuteSave(ctx);

  function commandDeps() {
    return {
      getContext: () => studyCommandContextFromStore(useStudyStore.getState()),
    };
  }

  return (
    <div className="solve-controls" role="group" aria-label="Solution files">
      <button
        type="button"
        className="toolbar-btn"
        disabled={!saveGate.ok}
        title={saveGate.reason}
        onClick={() => {
          const path = useStudyStore.getState().draft.solutionPath.trim();
          if (path) {
            void executeSave({
              ...commandDeps(),
              save: async () => saveSolution(path),
            });
            return;
          }
          // No path yet — in-app catalogue (not OS picker).
          openCatalogue("save");
        }}
      >
        Save
      </button>
      <button
        type="button"
        className="toolbar-btn"
        onClick={() => openCatalogue("open")}
      >
        Open
      </button>
    </div>
  );
}
