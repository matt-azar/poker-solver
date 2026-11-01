import { useMemo, useRef, useState } from "react";
import { useStudyStore } from "../../state/studyStore";
import {
  fastSolveDefaults,
  formatHardwareHint,
} from "../../domain/hardwareDefaults";
import { comboCount } from "../../domain/range";
import { RANKS } from "../../domain/types";
import { AssistantPanel } from "../assistant/AssistantPanel";
import { RangeCataloguePanel } from "../profiles/RangeCataloguePanel";

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
  const undoRange = useStudyStore((s) => s.undoRange);
  const redoRange = useStudyStore((s) => s.redoRange);
  const canUndoRange = useStudyStore((s) => s.canUndoRange);
  const canRedoRange = useStudyStore((s) => s.canRedoRange);
  const setupMeta = useStudyStore((s) => s.setupMeta);
  const solve = useStudyStore((s) => s.solve);
  const setWorkspace = useStudyStore((s) => s.setWorkspace);
  const potProvenance = provenanceHint(setupMeta, "pot");
  const stackProvenance = provenanceHint(setupMeta, "stack");
  const solveBlocked = setupMeta != null && !setupMeta.canSolve;
  const machineDefaults = useMemo(() => fastSolveDefaults(), []);
  const hardwareHint = formatHardwareHint(machineDefaults);

  const [showTextOop, setShowTextOop] = useState(false);
  const [showTextIp, setShowTextIp] = useState(false);
  const [catalogueOpen, setCatalogueOpen] = useState<"oop" | "ip" | null>(null);

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
            className="toolbar-btn primary"
            title={solveBlocked ? "Finish missing setup fields before solving" : undefined}
            onClick={() => {
              void solve();
              setWorkspace("study");
            }}
          >
            Solve &amp; open Study
          </button>
        </div>
      </header>

      <AssistantPanel />

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
            <div className="panel-title-row">
              <h2>{catalogueOpen.toUpperCase()} range catalogue</h2>
              <button
                type="button"
                className="toolbar-btn"
                onClick={() => setCatalogueOpen(null)}
              >
                Close
              </button>
            </div>
            <p className="field-hint">
              Catalogue apply updates both seats; opened from {catalogueOpen.toUpperCase()}.
            </p>
            <RangeCataloguePanel />
          </div>
        </div>
      ) : null}

      <div className="build-grid">
        <section className="build-section">
          <h2>Spot</h2>
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
        </section>

        <section className="build-section">
          <h2>Ranges</h2>
          <div className="range-toolbar">
            <label>
              Paint weight
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={paintWeight}
                onChange={(event) => setPaintWeight(Number(event.target.value))}
              />
              <span className="tabular">{paintWeight.toFixed(2)}</span>
            </label>
            <button type="button" className="toolbar-btn" disabled={!canUndoRange} onClick={undoRange}>
              Undo
            </button>
            <button type="button" className="toolbar-btn" disabled={!canRedoRange} onClick={redoRange}>
              Redo
            </button>
          </div>
          {(["oop", "ip"] as const).map((player) => (
            <div key={player} className="range-editor">
              <div className="panel-title-row">
                <h3>{player.toUpperCase()}</h3>
                <div className="build-inline">
                  <button
                    type="button"
                    className="toolbar-btn"
                    onClick={() => setCatalogueOpen(player)}
                  >
                    Catalogue…
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
        </section>

        <section className="build-section">
          <h2>Betting tree</h2>
          <p className="field-hint">
            Sizes are % of pot (75 = 75%). Use e / 2e / 3e for geometric when Geometric is off.
          </p>
          <div className="build-inline">
            <label>
              Flop OOP
              <input
                value={draft.oopFlop}
                placeholder="50, 100"
                onChange={(event) => updateDraft({ oopFlop: event.target.value })}
              />
            </label>
            <label>
              Flop IP
              <input
                value={draft.ipFlop}
                placeholder="50, 100"
                onChange={(event) => updateDraft({ ipFlop: event.target.value })}
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={draft.donkFlop}
                onChange={(event) => updateDraft({ donkFlop: event.target.checked })}
              />
              Donk
            </label>
          </div>
          <div className="build-inline">
            <label>
              Turn OOP
              <input
                value={draft.oopTurn}
                placeholder="33, 75, e"
                onChange={(event) => updateDraft({ oopTurn: event.target.value })}
              />
            </label>
            <label>
              Turn IP
              <input
                value={draft.ipTurn}
                placeholder="33, 75, e"
                onChange={(event) => updateDraft({ ipTurn: event.target.value })}
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={draft.donkTurn}
                onChange={(event) => updateDraft({ donkTurn: event.target.checked })}
              />
              Donk
            </label>
          </div>
          <div className="build-inline">
            <label>
              River OOP
              <input
                value={draft.oopRiver}
                placeholder="50, 100"
                onChange={(event) => updateDraft({ oopRiver: event.target.value })}
              />
            </label>
            <label>
              River IP
              <input
                value={draft.ipRiver}
                placeholder="50, 100"
                onChange={(event) => updateDraft({ ipRiver: event.target.value })}
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={draft.donkRiver}
                onChange={(event) => updateDraft({ donkRiver: event.target.checked })}
              />
              Donk
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
            <label className="check">
              <input
                type="checkbox"
                checked={draft.geometric}
                onChange={(event) => updateDraft({ geometric: event.target.checked })}
              />
              Geometric
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={draft.allowAllIn}
                onChange={(event) => updateDraft({ allowAllIn: event.target.checked })}
              />
              All-in
            </label>
          </div>
        </section>

        <section className="build-section">
          <h2>Solve settings</h2>
          <p className="build-hardware-hint muted" title="Defaults match a fast local solve">
            Fast defaults · {hardwareHint}
            <button
              type="button"
              className="toolbar-btn"
              onClick={() =>
                updateDraft({
                  threads: machineDefaults.threads,
                  memoryMib: machineDefaults.memoryMib,
                  frozen: true,
                })
              }
            >
              Reset to fast
            </button>
          </p>
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
              Accuracy (NashConv/pot)
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
            <label>
              Samples
              <input
                type="number"
                value={draft.samples}
                onChange={(event) => updateDraft({ samples: Number(event.target.value) })}
              />
            </label>
            <label>
              Algorithm
              <select
                value={draft.algorithm}
                onChange={(event) => updateDraft({ algorithm: event.target.value })}
              >
                <option value="cfr_plus">CFR+</option>
                <option value="cfr">Vanilla CFR</option>
                <option value="dcfr">DCFR</option>
              </select>
            </label>
            <label>
              Threads
              <input
                type="number"
                min={1}
                max={64}
                value={draft.threads}
                onChange={(event) =>
                  updateDraft({
                    threads: Number(event.target.value),
                    frozen: true,
                  })
                }
              />
            </label>
            <label>
              Memory MiB
              <input
                type="number"
                min={64}
                value={draft.memoryMib}
                onChange={(event) => updateDraft({ memoryMib: Number(event.target.value) })}
              />
            </label>
          </div>
          <div className="build-inline">
            <label>
              Solution path
              <input
                value={draft.solutionPath}
                onChange={(event) => updateDraft({ solutionPath: event.target.value })}
                placeholder="/tmp/spot.psol"
              />
            </label>
          </div>
          <div className="build-inline">
            <label>
              Incentives
              <input
                value={draft.incentives}
                onChange={(event) => updateDraft({ incentives: event.target.value })}
                placeholder="label 0 b100 3.5; tag 1 bluff -2"
              />
            </label>
            <label>
              Edge tags
              <input
                value={draft.edgeTags}
                onChange={(event) => updateDraft({ edgeTags: event.target.value })}
                placeholder="b100 bluff; 1 f give_up"
              />
            </label>
          </div>
        </section>
      </div>
    </div>
  );
}
