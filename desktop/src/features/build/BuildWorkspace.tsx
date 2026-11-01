import { useStudyStore } from "../../state/studyStore";
import { comboCount } from "../../domain/range";
import { RANKS } from "../../domain/types";
import { AssistantPanel } from "../assistant/AssistantPanel";
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

export function BuildWorkspace() {
  const draft = useStudyStore((s) => s.draft);
  const updateDraft = useStudyStore((s) => s.updateDraft);
  const weights = useStudyStore((s) => s.weights);
  const setRangeText = useStudyStore((s) => s.setRangeText);
  const paintCell = useStudyStore((s) => s.paintCell);
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
  const boardLen = draft.boardText.trim().split(/[\s,]+/).filter(Boolean).length;
  const potProvenance = provenanceHint(setupMeta, "pot");
  const stackProvenance = provenanceHint(setupMeta, "stack");
  const solveBlocked = setupMeta != null && !setupMeta.canSolve;

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
                <button
                  type="button"
                  className="toolbar-btn"
                  onClick={() => clearRange(player)}
                >
                  Clear
                </button>
              </div>
              <textarea
                rows={3}
                value={player === "oop" ? draft.oopRange : draft.ipRange}
                onChange={(event) => setRangeText(player, event.target.value)}
              />
              <div className="range-paint-grid" role="grid" aria-label={`${player} range`}>
                {RANKS.map((rowRank, row) =>
                  RANKS.map((colRank, col) => {
                    const weight = weights[player][row][col];
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
                        data-on={weight > 0}
                        style={
                          weight > 0
                            ? {
                                background: `rgba(63, 143, 107, ${0.25 + 0.75 * Math.min(weight, 1)})`,
                              }
                            : undefined
                        }
                        onClick={() => paintCell(player, row, col)}
                        title={label}
                      >
                        {label}
                      </button>
                    );
                  }),
                )}
              </div>
            </div>
          ))}
        </section>

        <section className="build-section">
          <h2>Betting tree</h2>
          <div className="build-inline">
            <label>
              OOP bets
              <input
                value={draft.oopBets}
                onChange={(event) => updateDraft({ oopBets: event.target.value })}
              />
            </label>
            <label>
              IP bets
              <input
                value={draft.ipBets}
                onChange={(event) => updateDraft({ ipBets: event.target.value })}
              />
            </label>
          </div>
          {boardLen <= 3 ? (
            <div className="build-inline">
              <label>
                OOP flop
                <input
                  value={draft.oopFlop}
                  onChange={(event) => updateDraft({ oopFlop: event.target.value })}
                />
              </label>
              <label>
                IP flop
                <input
                  value={draft.ipFlop}
                  onChange={(event) => updateDraft({ ipFlop: event.target.value })}
                />
              </label>
            </div>
          ) : null}
          {boardLen <= 4 ? (
            <div className="build-inline">
              <label>
                OOP turn
                <input
                  value={draft.oopTurn}
                  onChange={(event) => updateDraft({ oopTurn: event.target.value })}
                />
              </label>
              <label>
                IP turn
                <input
                  value={draft.ipTurn}
                  onChange={(event) => updateDraft({ ipTurn: event.target.value })}
                />
              </label>
            </div>
          ) : null}
          <div className="build-inline">
            <label>
              OOP river
              <input
                value={draft.oopRiver}
                onChange={(event) => updateDraft({ oopRiver: event.target.value })}
              />
            </label>
            <label>
              IP river
              <input
                value={draft.ipRiver}
                onChange={(event) => updateDraft({ ipRiver: event.target.value })}
              />
            </label>
          </div>
          <div className="build-inline">
            <label>
              OOP donk
              <input
                value={draft.oopDonk}
                onChange={(event) => updateDraft({ oopDonk: event.target.value })}
              />
            </label>
            <label>
              Pot cap
              <input
                type="number"
                value={draft.potCap}
                onChange={(event) => updateDraft({ potCap: Number(event.target.value) })}
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

        <TreeLineEditor />

        <section className="build-section">
          <h2>Solve settings</h2>
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
                value={draft.threads}
                onChange={(event) => updateDraft({ threads: Number(event.target.value) })}
              />
            </label>
            <label>
              Memory MiB
              <input
                type="number"
                value={draft.memoryMib}
                onChange={(event) => updateDraft({ memoryMib: Number(event.target.value) })}
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={draft.frozen}
                onChange={(event) => updateDraft({ frozen: event.target.checked })}
              />
              Frozen
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
