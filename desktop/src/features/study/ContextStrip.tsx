import { useStudyStore } from "../../state/studyStore";
import { SolveControls } from "./SolveControls";

function formatBoard(
  board: string[] | string | null | undefined,
  draftBoard: string,
): string {
  if (Array.isArray(board) && board.length) {
    return board.join(" ");
  }
  if (typeof board === "string" && board.trim()) {
    return board;
  }
  return draftBoard || "—";
}

function toActLabel(
  toAct: string | null | undefined,
  player: number | null | undefined,
): string {
  if (toAct) {
    return toAct;
  }
  if (player === 0) {
    return "OOP";
  }
  if (player === 1) {
    return "IP";
  }
  return "—";
}

export function ContextStrip() {
  const draft = useStudyStore((s) => s.draft);
  const status = useStudyStore((s) => s.status);
  const currentNode = useStudyStore((s) => s.currentNode);
  const phase = useStudyStore((s) => s.phase);
  const solutionId = useStudyStore((s) => s.solutionId);

  const board = formatBoard(currentNode?.board ?? status?.board, draft.boardText);
  const pot = Number(currentNode?.pot ?? status?.pot ?? draft.pot);
  const stack = Number(status?.stack ?? draft.stack);
  const spr = pot > 0 ? (stack / pot).toFixed(2) : "—";
  const toAct = toActLabel(currentNode?.to_act, currentNode?.player ?? null);
  const line = currentNode?.line || currentNode?.node_id || "root";

  return (
    <div className="context-strip">
      <div className="context-strip__group">
        <span className="context-strip__label">Board</span>
        <span className="context-strip__value context-strip__board">{board}</span>
      </div>
      <div className="context-strip__sep" />
      <div className="context-strip__group">
        <span className="context-strip__label">Pot</span>
        <span className="context-strip__value">{pot}</span>
      </div>
      <div className="context-strip__group">
        <span className="context-strip__label">Stack / SPR</span>
        <span className="context-strip__value">
          {stack} / {spr}
        </span>
      </div>
      <div className="context-strip__sep" />
      <div className="context-strip__group">
        <span className="context-strip__label">To act</span>
        <span className="context-strip__value">{toAct}</span>
      </div>
      <div className="context-strip__group">
        <span className="context-strip__label">Line</span>
        <span className="context-strip__value" title={line}>
          {line}
        </span>
      </div>
      <div className="context-strip__grow" />
      <span className="phase-pill" data-phase={phase}>
        {phase}
        {solutionId ? ` · ${solutionId.slice(0, 8)}` : ""}
      </span>
      <SolveControls />
    </div>
  );
}
