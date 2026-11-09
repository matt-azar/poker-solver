/**
 * Build page — ranges, board, tree sizes, solve.
 * Paint-grid / section chrome: styles/layout.css (.build-*, .range-paint-grid, .paint-cell).
 * Catalogue tree: SeatActionCatalogueTree (+ .seat-tree* in layout.css).
 */
import { useEffect, useRef, useState } from "react";
import {
  canExecuteSolve,
  studyCommandContextFromStore,
} from "../../commands/studyCommands";
import { useStudyStore } from "../../state/studyStore";
import { useEquityStore } from "../../state/equityStore";
import { draftFromBuild } from "../../domain/equity/transfer";
import { comboCount } from "../../domain/range";
import { RANKS } from "../../domain/types";
import { SeatActionCatalogueTree } from "./SeatActionCatalogueTree";
import { TreeLineEditor } from "./TreeLineEditor";

function provenanceHint(
  setupMeta: ReturnType<typeof useStudyStore.getState>["setupMeta"],
  field: string,
): string | null {
  const source = setupMeta?.provenance?.[field];
  if (!source) {
    return null;
  }
  return source.replace(/_/g, " ");
}

function cellFromPoint(
  root: HTMLElement,
  clientX: number,
  clientY: number,
): { row: number; col: number } | null {
  const hit = document.elementFromPoint(clientX, clientY);
  const button = hit?.closest<HTMLElement>("[data-row][data-col]");
  if (!button || !root.contains(button)) {
    return null;
  }
  const row = Number(button.dataset.row);
  const col = Number(button.dataset.col);
  if (!Number.isInteger(row) || !Number.isInteger(col)) {
    return null;
  }
  return { row, col };
}

function RangePaintGrid({ player }: { player: "oop" | "ip" }) {
  const weights = useStudyStore((s) => s.weights[player]);
  const beginPaintStroke = useStudyStore((s) => s.beginPaintStroke);
  const continuePaintStroke = useStudyStore((s) => s.continuePaintStroke);
  const endPaintStroke = useStudyStore((s) => s.endPaintStroke);
  const gridRef = useRef<HTMLDivElement>(null);
  const paintingRef = useRef(false);

  const finishStroke = () => {
    if (!paintingRef.current) {
      return;
    }
    paintingRef.current = false;
    endPaintStroke();
  };

  return (
    <div
      ref={gridRef}
      className="range-paint-grid"
      role="grid"
      aria-label={`${player} range`}
      onPointerDown={(event) => {
        if (event.button !== 0 || !gridRef.current) {
          return;
        }
        const cell = cellFromPoint(gridRef.current, event.clientX, event.clientY);
        if (!cell) {
          return;
        }
        event.preventDefault();
        paintingRef.current = true;
        beginPaintStroke(player, cell.row, cell.col);
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!paintingRef.current || !gridRef.current) {
          return;
        }
        const cell = cellFromPoint(gridRef.current, event.clientX, event.clientY);
        if (!cell) {
          return;
        }
        continuePaintStroke(player, cell.row, cell.col);
      }}
      onPointerUp={finishStroke}
      onPointerCancel={finishStroke}
      onLostPointerCapture={finishStroke}
    >
      {RANKS.map((rowRank, row) =>
        RANKS.map((colRank, col) => {
          const weight = weights[row][col];
          const label =
            row === col
              ? `${rowRank}${colRank}`
              : row < col
                ? `${rowRank}${colRank}s`
                : `${colRank}${rowRank}o`;
          return (
            <button
              key={`${player}-${row}-${col}`}
              type="button"
              className="paint-cell"
              data-row={row}
              data-col={col}
              data-on={weight > 0}
              style={
                weight > 0
                  ? {
                      background: `rgba(63, 143, 107, ${0.25 + 0.75 * Math.min(weight, 1)})`,
                    }
                  : undefined
              }
              title={label}
              onClick={(event) => {
                // Pointer strokes paint on pointerdown (preventDefault suppresses the
                // mouse click). Keyboard activation still synthesizes click.
                if (event.detail !== 0) {
                  return;
                }
                beginPaintStroke(player, row, col);
                endPaintStroke();
              }}
            >
              {label}
            </button>
          );
        }),
      )}
    </div>
  );
}

export function BuildWorkspace() {
  const draft = useStudyStore((s) => s.draft);
  const updateDraft = useStudyStore((s) => s.updateDraft);
  const weights = useStudyStore((s) => s.weights);
  const setRangeText = useStudyStore((s) => s.setRangeText);
  const paintWeight = useStudyStore((s) => s.paintWeight);
  const setPaintWeight = useStudyStore((s) => s.setPaintWeight);
  const clearRange = useStudyStore((s) => s.clearRange);
  const swapRanges = useStudyStore((s) => s.swapRanges);
  const undoRange = useStudyStore((s) => s.undoRange);
  const redoRange = useStudyStore((s) => s.redoRange);
  const canUndoRange = useStudyStore((s) => s.canUndoRange);
  const canRedoRange = useStudyStore((s) => s.canRedoRange);
  const setupMeta = useStudyStore((s) => s.setupMeta);
  const solveValidationErrors = useStudyStore((s) => s.solveValidationErrors);
  const setWorkspace = useStudyStore((s) => s.setWorkspace);
  const phase = useStudyStore((s) => s.phase);
  const solutionId = useStudyStore((s) => s.solutionId);
  const workspace = useStudyStore((s) => s.workspace);
  const currentNode = useStudyStore((s) => s.currentNode);
  const potProvenance = provenanceHint(setupMeta, "pot");
  const stackProvenance = provenanceHint(setupMeta, "stack");
  // Live draft validation + engine phase — never stale setupMeta.canSolve.
  const solveGate = canExecuteSolve(
    studyCommandContextFromStore({
      phase,
      draft,
      solutionId,
      workspace,
      currentNode,
      solveValidationErrors,
    }),
  );
  const solveBlocked = !solveGate.ok;
  const solveErrors = !solveGate.ok
    ? solveValidationErrors.length > 0
      ? solveValidationErrors
      : [solveGate.reason]
    : solveValidationErrors;

  const [showTextOop, setShowTextOop] = useState(false);
  const [showTextIp, setShowTextIp] = useState(false);
  const [catalogueOpen, setCatalogueOpen] = useState<"oop" | "ip" | null>(null);
  const [paintWeightDraft, setPaintWeightDraft] = useState(
    paintWeight.toFixed(2),
  );

  useEffect(() => {
    setPaintWeightDraft(paintWeight.toFixed(2));
  }, [paintWeight]);

  const commitPaintWeightDraft = (raw: string) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      setPaintWeightDraft(paintWeight.toFixed(2));
      return;
    }
    const clamped = Math.max(0, Math.min(1, parsed));
    setPaintWeight(clamped);
    setPaintWeightDraft(clamped.toFixed(2));
  };

  const showTextFor = (player: "oop" | "ip") =>
    player === "oop" ? showTextOop : showTextIp;
  const setShowTextFor = (player: "oop" | "ip", next: boolean) => {
    if (player === "oop") {
      setShowTextOop(next);
    } else {
      setShowTextIp(next);
    }
  };

  return (
    <div className="build-workspace">
      <header className="build-header">
        <div>
          <h1>Build</h1>
          {setupMeta?.profile ? (
            <p className="build-profile-note">
              Profile {setupMeta.profile.displayName} ({setupMeta.profile.classification})
            </p>
          ) : null}
        </div>
        <div className="build-summary">
          <span>{draft.boardText || "no board"}</span>
          <span>
            pot {draft.pot} · stack {draft.stack}
          </span>
          <span>
            OOP {comboCount(weights.oop, draft.boardText).toFixed(1)} · IP{" "}
            {comboCount(weights.ip, draft.boardText).toFixed(1)}
          </span>
          <button
            type="button"
            className="toolbar-btn"
            title="Copy current Build ranges and board into the Equity calculator"
            onClick={() => {
              useEquityStore.getState().importDraft(
                draftFromBuild({
                  oopRange: draft.oopRange,
                  ipRange: draft.ipRange,
                  boardText: draft.boardText,
                }),
              );
              setWorkspace("equity");
            }}
          >
            Open ranges in Equity
          </button>
        </div>
      </header>

      {solveBlocked && solveErrors.length > 0 ? (
        <div className="build-solve-errors" role="alert">
          <p>Solve is blocked until the Build draft is valid:</p>
          <ul>
            {solveErrors.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {catalogueOpen ? (
        <div
          className="catalogue-modal-overlay"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setCatalogueOpen(null);
            }
          }}
        >
          <div
            className="catalogue-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`${catalogueOpen.toUpperCase()} range catalogue`}
          >
            <div className="range-editor__head">
              <h2>{catalogueOpen.toUpperCase()} range</h2>
              <button
                type="button"
                className="toolbar-btn"
                onClick={() => setCatalogueOpen(null)}
              >
                Close
              </button>
            </div>
            <SeatActionCatalogueTree
              saveSource={{
                label: catalogueOpen.toUpperCase(),
                rangeText:
                  catalogueOpen === "oop" ? draft.oopRange : draft.ipRange,
              }}
              onPick={(atom) => {
                setRangeText(catalogueOpen, atom.range);
                setCatalogueOpen(null);
              }}
            />
          </div>
        </div>
      ) : null}

      <div className="build-grid">
        <section className="build-section" data-span="2">
          <label>
            Board
            <input
              value={draft.boardText}
              onChange={(event) => updateDraft({ boardText: event.target.value })}
            />
            {!draft.boardText.trim() ? (
              <span className="field-hint">Required for a postflop solve</span>
            ) : null}
          </label>
          <div className="build-inline">
            <label>
              Pot{potProvenance ? ` · ${potProvenance}` : ""}
              <input
                type="number"
                value={draft.pot}
                onChange={(event) => updateDraft({ pot: Number(event.target.value) })}
              />
            </label>
            <label>
              Stack{stackProvenance ? ` · ${stackProvenance}` : ""}
              <input
                type="number"
                value={draft.stack}
                onChange={(event) => updateDraft({ stack: Number(event.target.value) })}
              />
            </label>
            <label>
              Max raises
              <input
                type="number"
                value={draft.maxRaises}
                onChange={(event) => updateDraft({ maxRaises: Number(event.target.value) })}
              />
            </label>
          </div>

          <h3 className="build-subhead">Betting tree</h3>
          <div className="build-inline">
            <label>
              Flop OOP bets
              <input
                value={draft.oopFlop}
                onChange={(event) => updateDraft({ oopFlop: event.target.value })}
              />
            </label>
            <label>
              Flop IP bets
              <input
                value={draft.ipFlop}
                onChange={(event) => updateDraft({ ipFlop: event.target.value })}
              />
            </label>
            <label>
              Flop OOP raises
              <input
                value={draft.oopFlopRaises}
                onChange={(event) => updateDraft({ oopFlopRaises: event.target.value })}
              />
            </label>
            <label>
              Flop IP raises
              <input
                value={draft.ipFlopRaises}
                onChange={(event) => updateDraft({ ipFlopRaises: event.target.value })}
              />
            </label>
          </div>
          <div className="build-inline">
            <label>
              Turn OOP bets
              <input
                value={draft.oopTurn}
                onChange={(event) => updateDraft({ oopTurn: event.target.value })}
              />
            </label>
            <label>
              Turn IP bets
              <input
                value={draft.ipTurn}
                onChange={(event) => updateDraft({ ipTurn: event.target.value })}
              />
            </label>
            <label>
              Turn OOP raises
              <input
                value={draft.oopTurnRaises}
                onChange={(event) => updateDraft({ oopTurnRaises: event.target.value })}
              />
            </label>
            <label>
              Turn IP raises
              <input
                value={draft.ipTurnRaises}
                onChange={(event) => updateDraft({ ipTurnRaises: event.target.value })}
              />
            </label>
            <label>
              Turn donk
              <input
                value={draft.oopTurnDonk}
                onChange={(event) => updateDraft({ oopTurnDonk: event.target.value })}
              />
            </label>
          </div>
          <div className="build-inline">
            <label>
              River OOP bets
              <input
                value={draft.oopRiver}
                onChange={(event) => updateDraft({ oopRiver: event.target.value })}
              />
            </label>
            <label>
              River IP bets
              <input
                value={draft.ipRiver}
                onChange={(event) => updateDraft({ ipRiver: event.target.value })}
              />
            </label>
            <label>
              River OOP raises
              <input
                value={draft.oopRiverRaises}
                onChange={(event) => updateDraft({ oopRiverRaises: event.target.value })}
              />
            </label>
            <label>
              River IP raises
              <input
                value={draft.ipRiverRaises}
                onChange={(event) => updateDraft({ ipRiverRaises: event.target.value })}
              />
            </label>
            <label>
              River donk
              <input
                value={draft.oopRiverDonk}
                onChange={(event) => updateDraft({ oopRiverDonk: event.target.value })}
              />
            </label>
          </div>
          <div className="build-inline">
            <label>
              Pot cap
              <input
                type="number"
                value={draft.potCap}
                onChange={(event) => updateDraft({ potCap: Number(event.target.value) })}
              />
            </label>
            <label>
              Merge threshold (%)
              <input
                type="number"
                value={draft.mergeThresholdPct}
                onChange={(event) =>
                  updateDraft({ mergeThresholdPct: Number(event.target.value) })
                }
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={draft.noThreeBet}
                onChange={(event) => updateDraft({ noThreeBet: event.target.checked })}
              />
              No 3-bet
            </label>
          </div>

          <h3 className="build-subhead">Stop</h3>
          <div className="build-inline">
            <label>
              Iterations
              <input
                type="number"
                value={draft.iterations}
                onChange={(event) => updateDraft({ iterations: Number(event.target.value) })}
              />
            </label>
            <label>
              Accuracy (pot fraction)
              <input
                value={draft.accuracy}
                placeholder="off"
                onChange={(event) => updateDraft({ accuracy: event.target.value })}
              />
            </label>
            <label>
              Time limit (s)
              <input
                value={draft.timeLimit}
                placeholder="off"
                onChange={(event) => updateDraft({ timeLimit: event.target.value })}
              />
            </label>
          </div>
        </section>

        <TreeLineEditor />

        <section className="build-section" data-span="2">
          <h2>Ranges</h2>
          <div className="range-toolbar">
            <label className="paint-weight-field">
              Paint weight
              <div className="paint-weight-controls">
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={paintWeight}
                  aria-label="Paint weight slider"
                  onChange={(event) => setPaintWeight(Number(event.target.value))}
                />
                <input
                  type="number"
                  className="paint-weight-input tabular"
                  min={0}
                  max={1}
                  step={0.01}
                  value={paintWeightDraft}
                  aria-label="Paint weight value"
                  onChange={(event) => setPaintWeightDraft(event.target.value)}
                  onBlur={(event) => commitPaintWeightDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.currentTarget.blur();
                    }
                  }}
                />
              </div>
            </label>
            <button type="button" className="toolbar-btn" disabled={!canUndoRange} onClick={undoRange}>
              Undo
            </button>
            <button type="button" className="toolbar-btn" disabled={!canRedoRange} onClick={redoRange}>
              Redo
            </button>
            <button
              type="button"
              className="toolbar-btn"
              title="Swap OOP and IP range values"
              onClick={swapRanges}
            >
              Swap
            </button>
          </div>
          <div className="range-pair">
          {(["oop", "ip"] as const).map((player) => (
            <div key={player} className="range-editor">
              <div className="range-editor__head">
                <h3>{player.toUpperCase()}</h3>
                <button
                  type="button"
                  className="toolbar-btn"
                  onClick={() => setCatalogueOpen(player)}
                >
                  Catalogue
                </button>
                <button
                  type="button"
                  className="toolbar-btn"
                  onClick={() => setShowTextFor(player, !showTextFor(player))}
                >
                  {showTextFor(player) ? "Hide range text" : "Show range text"}
                </button>
                <button
                  type="button"
                  className="toolbar-btn"
                  onClick={() => clearRange(player)}
                >
                  Clear
                </button>
              </div>
              {showTextFor(player) ? (
                <textarea
                  rows={3}
                  value={player === "oop" ? draft.oopRange : draft.ipRange}
                  onChange={(event) => setRangeText(player, event.target.value)}
                />
              ) : null}
              <RangePaintGrid player={player} />
            </div>
          ))}
          </div>
        </section>
      </div>
    </div>
  );
}
