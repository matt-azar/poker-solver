import { useEffect, useMemo, useState } from "react";
import {
  paintClassAt,
  parseExactRange,
  weightsFromExact,
  type ExactRange,
} from "../../domain/range";
import { formatEquityPercent, validateEquityDraft } from "../../domain/equity/validation";
import { useEquityStore } from "../../state/equityStore";
import { SeatActionCatalogueTree } from "../build/SeatActionCatalogueTree";
import { ControlledRangeGrid } from "./ControlledRangeGrid";
import { EquityCardPicker } from "./EquityCardPicker";

export function EquityWorkspace() {
  const draft = useEquityStore((s) => s.draft);
  const run = useEquityStore((s) => s.run);
  const recent = useEquityStore((s) => s.recent);
  const setName = useEquityStore((s) => s.setName);
  const setMethod = useEquityStore((s) => s.setMethod);
  const setBoardText = useEquityStore((s) => s.setBoardText);
  const setDeadText = useEquityStore((s) => s.setDeadText);
  const setPlayerLabel = useEquityStore((s) => s.setPlayerLabel);
  const setPlayerEnabled = useEquityStore((s) => s.setPlayerEnabled);
  const setPlayerRangeText = useEquityStore((s) => s.setPlayerRangeText);
  const setPlayerExactRange = useEquityStore((s) => s.setPlayerExactRange);
  const selectPlayer = useEquityStore((s) => s.selectPlayer);
  const addPlayer = useEquityStore((s) => s.addPlayer);
  const removePlayer = useEquityStore((s) => s.removePlayer);
  const clearPlayer = useEquityStore((s) => s.clearPlayer);
  const randomPlayer = useEquityStore((s) => s.randomPlayer);
  const calculate = useEquityStore((s) => s.calculate);
  const stop = useEquityStore((s) => s.stop);
  const refreshJob = useEquityStore((s) => s.refreshJob);
  const restoreRecent = useEquityStore((s) => s.restoreRecent);
  const deleteRecent = useEquityStore((s) => s.deleteRecent);
  const exportDraftJson = useEquityStore((s) => s.exportDraftJson);
  const importDraftJson = useEquityStore((s) => s.importDraftJson);
  const copyResultsText = useEquityStore((s) => s.copyResultsText);

  const [paintWeight, setPaintWeight] = useState(1);
  const [pickerTarget, setPickerTarget] = useState<"board" | "dead" | "hand" | null>(null);
  const [handDraft, setHandDraft] = useState<string[]>([]);
  const [catalogueOpen, setCatalogueOpen] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [boardText, setBoardTextLocal] = useState(() => draft.board.join(" "));
  const [deadText, setDeadTextLocal] = useState(() => draft.deadCards.join(" "));

  useEffect(() => {
    if (run.jobId) {
      void refreshJob();
    }
  }, [run.jobId, refreshJob]);

  useEffect(() => {
    setBoardTextLocal(draft.board.join(" "));
  }, [draft.board]);

  useEffect(() => {
    setDeadTextLocal(draft.deadCards.join(" "));
  }, [draft.deadCards]);

  const selected = draft.players.find((player) => player.id === draft.selectedPlayerId)
    ?? draft.players[0];
  const selectedParsed = useMemo(
    () => parseExactRange(selected?.rangeText ?? ""),
    [selected?.rangeText],
  );
  const selectedExact: ExactRange = selectedParsed.range;
  const selectedWeights = useMemo(() => weightsFromExact(selectedExact), [selectedExact]);
  const validation = validateEquityDraft(draft);
  const result = run.stale ? run.previous?.result : run.status?.result;
  const resultPlayers = result?.players ?? [];

  const usedCards = useMemo(() => {
    const used = new Set<string>();
    for (const card of draft.board) {
      used.add(card);
    }
    for (const card of draft.deadCards) {
      used.add(card);
    }
    for (const card of handDraft) {
      used.add(card);
    }
    return used;
  }, [draft.board, draft.deadCards, handDraft]);

  const running =
    run.starting
    || run.status?.state === "queued"
    || run.status?.state === "preparing"
    || run.status?.state === "running"
    || run.status?.state === "stopping";

  function applyPaint(row: number, col: number) {
    if (!selected) {
      return;
    }
    const next = paintClassAt(selectedExact, row, col, paintWeight);
    setPlayerExactRange(selected.id, next);
  }

  function onPickCard(card: string) {
    if (pickerTarget === "board") {
      if (draft.board.length >= 5) {
        return;
      }
      setBoardText([...draft.board, card].join(" "));
      if (draft.board.length + 1 >= 5) {
        setPickerTarget(null);
      }
      return;
    }
    if (pickerTarget === "dead") {
      setDeadText([...draft.deadCards, card].join(" "));
      return;
    }
    if (pickerTarget === "hand" && selected) {
      const next = [...handDraft, card];
      setHandDraft(next);
      if (next.length === 2) {
        setPlayerRangeText(selected.id, `${next[0]}${next[1]}`);
        setHandDraft([]);
        setPickerTarget(null);
      }
    }
  }

  return (
    <div className="equity-workspace">
      <header className="equity-toolbar">
        <div className="equity-toolbar-main">
          <h1>Equity</h1>
          <input
            className="equity-name"
            value={draft.name}
            placeholder="Untitled scenario"
            aria-label="Scenario name"
            onChange={(event) => setName(event.target.value)}
          />
          <label className="equity-method">
            Method
            <select
              value={draft.method}
              onChange={(event) =>
                setMethod(event.target.value as "auto" | "exact" | "monte_carlo")
              }
            >
              <option value="auto">Auto</option>
              <option value="exact">Exact</option>
              <option value="monte_carlo">Monte Carlo</option>
            </select>
          </label>
        </div>
        <div className="equity-toolbar-actions">
          <button
            type="button"
            onClick={() => {
              const blob = new Blob([exportDraftJson()], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              const anchor = document.createElement("a");
              anchor.href = url;
              anchor.download = `${draft.name || "equity-scenario"}.json`;
              anchor.click();
              URL.revokeObjectURL(url);
            }}
          >
            Export JSON
          </button>
          <label className="equity-file-import">
            Import JSON
            <input
              type="file"
              accept="application/json,.json"
              hidden
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) {
                  return;
                }
                const text = await file.text();
                const outcome = importDraftJson(text);
                setImportError(outcome.ok ? null : outcome.error ?? "Import failed");
                event.target.value = "";
              }}
            />
          </label>
          <button
            type="button"
            onClick={async () => {
              const text = copyResultsText();
              if (text) {
                await navigator.clipboard.writeText(text);
              }
            }}
            disabled={!result}
          >
            Copy results
          </button>
        </div>
      </header>

      <div className="equity-layout">
        <section className="equity-main panel">
          <table className="equity-player-table">
            <thead>
              <tr>
                <th>On</th>
                <th>Player</th>
                <th>Range</th>
                <th>Combos</th>
                <th>Equity</th>
                <th>Win</th>
                <th>Tie</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {draft.players.map((player) => {
                const parsed = parseExactRange(player.rangeText);
                const comboCount = [...parsed.range.values()].filter((weight) => weight > 0).length;
                const rowResult = resultPlayers.find((item) => item.id === player.id);
                return (
                  <tr
                    key={player.id}
                    data-selected={player.id === selected?.id || undefined}
                    onClick={() => selectPlayer(player.id)}
                  >
                    <td>
                      <input
                        type="checkbox"
                        checked={player.enabled}
                        aria-label={`${player.label} enabled`}
                        onChange={(event) => setPlayerEnabled(player.id, event.target.checked)}
                        onClick={(event) => event.stopPropagation()}
                      />
                    </td>
                    <td>
                      <input
                        value={player.label}
                        aria-label="Player label"
                        onChange={(event) => setPlayerLabel(player.id, event.target.value)}
                        onClick={(event) => event.stopPropagation()}
                      />
                    </td>
                    <td>
                      <input
                        className="equity-range-input"
                        value={player.rangeText}
                        placeholder="e.g. QQ+,AJs+,AsKh"
                        aria-label={`${player.label} range`}
                        onChange={(event) => setPlayerRangeText(player.id, event.target.value)}
                        onClick={(event) => event.stopPropagation()}
                      />
                    </td>
                    <td className="num">{player.rangeText.trim() ? comboCount : "—"}</td>
                    <td className="num equity-emphasis">
                      {player.enabled ? formatEquityPercent(rowResult?.equity) : "—"}
                    </td>
                    <td className="num">{player.enabled ? formatEquityPercent(rowResult?.win) : "—"}</td>
                    <td className="num">{player.enabled ? formatEquityPercent(rowResult?.tie) : "—"}</td>
                    <td className="equity-row-actions">
                      <button
                        type="button"
                        className="ghost"
                        onClick={(event) => {
                          event.stopPropagation();
                          selectPlayer(player.id);
                          setHandDraft([]);
                          setPickerTarget("hand");
                        }}
                      >
                        Hand
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        onClick={(event) => {
                          event.stopPropagation();
                          selectPlayer(player.id);
                          setCatalogueOpen(true);
                        }}
                      >
                        Catalogue
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        onClick={(event) => {
                          event.stopPropagation();
                          randomPlayer(player.id);
                        }}
                      >
                        Random
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        onClick={(event) => {
                          event.stopPropagation();
                          clearPlayer(player.id);
                        }}
                      >
                        Clear
                      </button>
                      {draft.players.length > 2 ? (
                        <button
                          type="button"
                          className="ghost"
                          onClick={(event) => {
                            event.stopPropagation();
                            removePlayer(player.id);
                          }}
                        >
                          Remove
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="equity-board-row">
            <label>
              Board
              <input
                value={boardText}
                placeholder="flop turn river (0 or 3–5)"
                onChange={(event) => setBoardTextLocal(event.target.value)}
                onBlur={() => setBoardText(boardText)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    setBoardText(boardText);
                  }
                }}
              />
            </label>
            <button type="button" onClick={() => setPickerTarget("board")}>
              Pick board
            </button>
            <label>
              Dead
              <input
                value={deadText}
                placeholder="explicit dead cards"
                onChange={(event) => setDeadTextLocal(event.target.value)}
                onBlur={() => setDeadText(deadText)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    setDeadText(deadText);
                  }
                }}
              />
            </label>
            <button type="button" onClick={() => setPickerTarget("dead")}>
              Pick dead
            </button>
            <button type="button" onClick={() => addPlayer()} disabled={draft.players.length >= 6}>
              Add player
            </button>
          </div>

          <div className="equity-run-row">
            {running ? (
              <button type="button" className="primary" onClick={() => void stop()}>
                Stop
              </button>
            ) : (
              <button
                type="button"
                className="primary"
                disabled={!validation.ok}
                onClick={() => void calculate()}
              >
                Calculate
              </button>
            )}
            <div className="equity-status" role="status">
              {run.stale ? <span className="equity-stale">Previous calculation</span> : null}
              {run.status ? (
                <span>
                  {run.status.state}
                  {run.status.result
                    ? ` · ${run.status.result.actual_method}${
                        run.status.result.exact_complete
                          ? " (exact)"
                          : run.status.result.accepted_samples
                            ? ` · ${run.status.result.accepted_samples} samples`
                            : ""
                      }`
                    : ""}
                  {run.status.progress_total
                    ? ` · ${run.status.progress_done}/${run.status.progress_total}`
                    : ""}
                </span>
              ) : (
                <span>Ready — no solution required</span>
              )}
              {run.error ? <span className="equity-error">{run.error}</span> : null}
              {!validation.ok && !run.error ? (
                <span className="equity-error">{validation.errors[0]}</span>
              ) : null}
              {importError ? <span className="equity-error">{importError}</span> : null}
            </div>
          </div>
        </section>

        <aside className="equity-side panel">
          <div className="equity-editor-head">
            <h2>{selected?.label ?? "Range"} editor</h2>
            <label>
              Paint %
              <input
                type="number"
                min={0}
                max={100}
                step={5}
                value={Math.round(paintWeight * 100)}
                onChange={(event) =>
                  setPaintWeight(Math.max(0, Math.min(100, Number(event.target.value) || 0)) / 100)
                }
              />
            </label>
            <button type="button" onClick={() => selected && clearPlayer(selected.id)}>
              Clear
            </button>
            <button
              type="button"
              onClick={() => selected && setPlayerRangeText(selected.id, "random")}
            >
              All
            </button>
          </div>
          {selected ? (
            <>
              <ControlledRangeGrid
                label={`${selected.label} matrix`}
                weights={selectedWeights}
                exact={selectedExact}
                onPaint={applyPaint}
              />
              <textarea
                className="equity-range-textarea"
                value={selected.rangeText}
                rows={4}
                onChange={(event) => setPlayerRangeText(selected.id, event.target.value)}
              />
              {selectedParsed.errors.length ? (
                <p className="equity-error">
                  {selectedParsed.errors.map((error) => error.message).join("; ")}
                </p>
              ) : (
                <p className="muted">
                  {[...selectedExact.values()].filter((weight) => weight > 0).length} combos of 1,326
                  starting hands
                </p>
              )}
            </>
          ) : null}

          <div className="equity-recent">
            <h2>Recent</h2>
            {recent.length === 0 ? <p className="muted">No saved calculations yet.</p> : null}
            <ul>
              {recent.map((entry) => (
                <li key={entry.id}>
                  <button type="button" className="ghost" onClick={() => restoreRecent(entry.id)}>
                    {entry.name}
                  </button>
                  <button type="button" className="ghost" onClick={() => deleteRecent(entry.id)}>
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>

      {pickerTarget ? (
        <div className="equity-picker-overlay">
          <EquityCardPicker
            used={usedCards}
            onPick={onPickCard}
            onClose={() => {
              setPickerTarget(null);
              setHandDraft([]);
            }}
          />
        </div>
      ) : null}

      {catalogueOpen ? (
        <div className="catalogue-modal-overlay" onClick={() => setCatalogueOpen(false)}>
          <div
            className="catalogue-modal"
            role="dialog"
            aria-label="Range catalogue"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <h2>Range catalogue</h2>
              <button type="button" onClick={() => setCatalogueOpen(false)}>
                Close
              </button>
            </header>
            <SeatActionCatalogueTree
              onPick={(atom) => {
                if (selected) {
                  setPlayerRangeText(selected.id, atom.range);
                }
                setCatalogueOpen(false);
              }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
