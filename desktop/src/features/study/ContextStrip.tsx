import { useState } from "react";
import { boardBlockers } from "../../domain/cards";
import { useStudyStore } from "../../state/studyStore";
import { CardPicker } from "../tree/CardPicker";
import { SolveControls } from "./SolveControls";

function boardList(
  board: string[] | string | null | undefined,
  draftBoard: string,
): string[] {
  if (Array.isArray(board) && board.length) {
    return board.map(String);
  }
  if (typeof board === "string" && board.trim()) {
    return board.trim().split(/\s+/);
  }
  return draftBoard.trim() ? draftBoard.trim().split(/\s+/) : [];
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
  const [pickerOpen, setPickerOpen] = useState(false);

  const cards = boardList(currentNode?.board ?? status?.board, draft.boardText);
  const blockers = boardBlockers(cards);
  const pot = Number(currentNode?.pot ?? status?.pot ?? draft.pot);
  const stack = Number(status?.stack ?? draft.stack);
  const spr = pot > 0 ? (stack / pot).toFixed(2) : "—";
  const toAct = toActLabel(currentNode?.to_act, currentNode?.player ?? null);
  const line = currentNode?.line || currentNode?.node_id || "root";
  const chanceNode = currentNode?.kind === "chance";

  return (
    <div className="context-strip">
      <div className="context-strip__group">
        <span className="context-strip__label">Board</span>
        <div className="context-strip__board" role="group" aria-label="Board cards">
          {cards.length ? (
            cards.map((card, index) => (
              <button
                key={`${card}-${index}`}
                type="button"
                className="board-card"
                data-suit={card.slice(1, 2)?.toLowerCase()}
                data-blocker={blockers.has(card) ? "true" : "false"}
                title={chanceNode ? "Open next-card picker" : card}
                onClick={() => setPickerOpen(true)}
              >
                {card}
              </button>
            ))
          ) : (
            <span className="context-strip__value">—</span>
          )}
          {chanceNode ? (
            <button
              type="button"
              className="toolbar-btn"
              onClick={() => setPickerOpen(true)}
              aria-label="Open next-card picker"
            >
              Next…
            </button>
          ) : null}
        </div>
      </div>
      <CardPicker open={pickerOpen} onClose={() => setPickerOpen(false)} />
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
