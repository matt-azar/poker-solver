import { useEffect, useRef, useState } from "react";
import {
  nodeEffectiveStack,
  nodePot,
} from "../../domain/actionHistory";
import {
  boardGroups,
  dealStreetFromBoard,
  normalizeBoardCards,
  type DealStreet,
} from "../../domain/cards";
import { useStudyStore } from "../../state/studyStore";
import { PlayingCard } from "../cards/PlayingCard";
import { CardPicker } from "../tree/CardPicker";
import { SolveControls } from "./SolveControls";
import "../../styles/cards.css";

function boardList(
  board: string[] | string | null | undefined,
  draftBoard: string,
): string[] {
  const fromNode = normalizeBoardCards(board);
  if (fromNode.length) {
    return fromNode;
  }
  return normalizeBoardCards(draftBoard);
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
  const prepareBoardCardChange = useStudyStore((s) => s.prepareBoardCardChange);
  const clearBoardCardChange = useStudyStore((s) => s.clearBoardCardChange);
  const loadLineCardReport = useStudyStore((s) => s.loadLineCardReport);
  const boardChangeStreet = useStudyStore((s) => s.boardChangeStreet);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerStreet, setPickerStreet] = useState<DealStreet | null>(null);
  const arrivedNodeId = useRef<string | null | undefined>(undefined);

  const cards = boardList(currentNode?.board ?? status?.board, draft.boardText);
  const groups = boardGroups(cards);
  const rootPot = Number(status?.pot ?? draft.pot);
  const rootStack = Number(status?.stack ?? draft.stack);
  const pot = nodePot(currentNode, rootPot);
  const stack = nodeEffectiveStack(currentNode, rootStack);
  const spr = pot > 0 ? (stack / pot).toFixed(2) : "—";
  const dealNode = currentNode?.kind === "chance";
  const dealing = dealNode ? dealStreetFromBoard(currentNode?.board) : null;
  const toAct = dealNode
    ? "Deal"
    : toActLabel(currentNode?.to_act, currentNode?.player ?? null);
  const line = currentNode?.line || currentNode?.node_id || "root";
  const showRootConfig =
    currentNode != null &&
    (Number(currentNode.pot) !== rootPot ||
      nodeEffectiveStack(currentNode, rootStack) !== rootStack);

  const showTurnSlot = Boolean(groups.turn || dealing === "turn" || groups.river);
  const showRiverSlot = Boolean(groups.river || dealing === "river");
  const activeStreet = pickerOpen
    ? pickerStreet ?? boardChangeStreet ?? dealing
    : dealing;

  const openPickerFor = (street: DealStreet) => {
    void (async () => {
      const result = await prepareBoardCardChange(street);
      if (!result.ok) {
        return;
      }
      setPickerStreet(street);
      setPickerOpen(true);
    })();
  };

  const closePicker = () => {
    setPickerOpen(false);
    setPickerStreet(null);
    clearBoardCardChange();
  };

  // Flop or turn just closed: the next board card has to be chosen, so open
  // the selector once per arrival. Closing it stays closed until the node changes.
  useEffect(() => {
    const nodeId = currentNode?.node_id ?? null;
    if (arrivedNodeId.current === nodeId) {
      return;
    }
    setPickerOpen(false);
    setPickerStreet(null);
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) {
        return;
      }
      arrivedNodeId.current = nodeId;
      if (currentNode?.kind !== "chance" || (dealing !== "turn" && dealing !== "river")) {
        return;
      }
      const result = await prepareBoardCardChange(dealing);
      if (cancelled || !result.ok) {
        return;
      }
      if (useStudyStore.getState().currentNode?.node_id !== nodeId) {
        return;
      }
      setPickerStreet(dealing);
      setPickerOpen(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [currentNode, dealing, prepareBoardCardChange]);

  return (
    <div className="context-strip">
      <div className="context-strip__group">
        <span className="context-strip__label">Board</span>
        <div className="context-strip__board board-cards" role="group" aria-label="Board cards">
          {groups.flop.length ? (
            <div className="board-cards__group" role="group" aria-label="Flop">
              <span className="board-cards__group-label">Flop</span>
              <div className="board-cards__flop">
                {groups.flop.map((card, index) => (
                  <PlayingCard
                    key={`flop-${card}-${index}`}
                    card={card}
                    size="sm"
                    layout="inline"
                  />
                ))}
              </div>
            </div>
          ) : (
            <span className="context-strip__value">—</span>
          )}
          {showTurnSlot ? (
            <div
              className="board-cards__group"
              data-active={activeStreet === "turn" ? "true" : "false"}
              role="group"
              aria-label="Turn"
            >
              <span className="board-cards__group-label">Turn</span>
              <div
                className="board-cards__street"
                data-active={activeStreet === "turn" ? "true" : "false"}
              >
                <PlayingCard
                  card={groups.turn}
                  emptyLabel=""
                  size="sm"
                  layout="inline"
                  interactive
                  selected={activeStreet === "turn" && pickerOpen}
                  aria-label={groups.turn ? "Change turn card" : "Select a turn card"}
                  title={groups.turn ? "Change turn card" : "Select a turn card"}
                  onClick={() => openPickerFor("turn")}
                />
              </div>
            </div>
          ) : null}
          {showRiverSlot ? (
            <div
              className="board-cards__group"
              data-active={activeStreet === "river" ? "true" : "false"}
              role="group"
              aria-label="River"
            >
              <span className="board-cards__group-label">River</span>
              <div
                className="board-cards__street"
                data-active={activeStreet === "river" ? "true" : "false"}
              >
                <PlayingCard
                  card={groups.river}
                  emptyLabel=""
                  size="sm"
                  layout="inline"
                  interactive
                  selected={activeStreet === "river" && pickerOpen}
                  aria-label={
                    groups.river ? "Change river card" : "Select a river card"
                  }
                  title={groups.river ? "Change river card" : "Select a river card"}
                  onClick={() => openPickerFor("river")}
                />
              </div>
            </div>
          ) : null}
        </div>
      </div>
      <CardPicker open={pickerOpen} street={pickerStreet} onClose={closePicker} />
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
      {showRootConfig ? (
        <div className="context-strip__group" title="Root job pot / starting stack">
          <span className="context-strip__label">Root</span>
          <span className="context-strip__value">
            {rootPot} / {rootStack}
          </span>
        </div>
      ) : null}
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
      {currentNode &&
      currentNode.kind !== "chance" &&
      currentNode.kind !== "terminal" &&
      cards.length >= 4 ? (
        <button
          type="button"
          className="toolbar-btn"
          title="Compare this decision's action mix across turn or river cards"
          onClick={() => void loadLineCardReport()}
        >
          Compare cards
        </button>
      ) : null}
      <div className="context-strip__grow" />
      <SolveControls />
    </div>
  );
}
