/**
 * Build page — spot, ranges, betting tree, solve.
 * Paint-grid / section chrome: styles/layout.css (.build-*, .range-paint-grid, .paint-cell).
 * Catalogue tree: SeatActionCatalogueTree (+ .seat-tree* in layout.css).
 */
import { useEffect, useRef, useState } from "react";
import {
  canExecuteSolve,
  executeSolve,
  studyCommandContextFromStore,
} from "../../commands/studyCommands";
import { formatSizeListPreview } from "../../domain/betSizes";
import { draftFromBuild } from "../../domain/equity/transfer";
import { comboCount } from "../../domain/range";
import { RANKS } from "../../domain/types";
import { useEquityStore } from "../../state/equityStore";
import { useStudyStore } from "../../state/studyStore";
import { BettingTreeCatalogue } from "./BettingTreeCatalogue";
import { SeatActionCatalogueTree } from "./SeatActionCatalogueTree";
import { TreeLineEditor } from "./TreeLineEditor";
import { useTreePreviewPlan } from "./useTreePreviewPlan";

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

/**
 * Build paint-grid cell weight label. Only fractional weights strictly between
 * 0 and 1 get a number; empty and full-weight cells stay unlabeled.
 */
export function formatPaintCellWeight(weight: number): string | null {
  if (!(weight > 0 && weight < 1)) {
    return null;
  }
  return weight.toFixed(2);
}

function formatComboCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) {
    return "0 combos";
  }
  const rounded = Math.round(count * 100) / 100;
  return Number.isInteger(rounded)
    ? `${rounded} combos`
    : `${rounded.toFixed(2)} combos`;
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
          const weightLabel = formatPaintCellWeight(weight);
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
              title={weightLabel ? `${label} · ${weightLabel}` : label}
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
              <span className="paint-cell__hand">{label}</span>
              {weightLabel ? (
                <span className="paint-cell__weight">{weightLabel}</span>
              ) : null}
            </button>
          );
        }),
      )}
    </div>
  );
}

function SizeField({
  label,
  value,
  onChange,
  hideCaption = false,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  hideCaption?: boolean;
}) {
  const preview = formatSizeListPreview(value);
  return (
    <label className="build-size-field">
      {hideCaption ? null : label}
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
      />
      {preview ? (
        <span className="build-size-preview" aria-live="polite">
          {preview}
        </span>
      ) : null}
    </label>
  );
}

function MemoryPlanStrip({
  plan,
  pot,
  stack,
}: {
  plan: NonNullable<ReturnType<typeof useTreePreviewPlan>["plan"]>;
  pot: number;
  stack: number;
}) {
  const formatBytes = (bytes: number) => {
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1048576) {
      return `${(bytes / 1024).toFixed(1)} KiB`;
    }
    return `${(bytes / 1048576).toFixed(1)} MiB`;
  };
  return (
    <div
      className="memory-plan"
      data-over-budget={plan.fits_budget ? undefined : "true"}
    >
      <span>
        Plan peak {formatBytes(plan.estimated_peak_bytes)}
        {plan.fits_budget ? "" : " (over budget)"}
      </span>
      <span>
        Budget {formatBytes(plan.memory_budget_bytes)} · {plan.public_decisions}{" "}
        decisions · {plan.deals} deals
      </span>
      <span className="tree-meta">
        pot {pot} · stack {stack}
      </span>
    </div>
  );
}

export function BuildWorkspace() {
  const draft = useStudyStore((s) => s.draft);
  const updateDraft = useStudyStore((s) => s.updateDraft);
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
  const weights = useStudyStore((s) => s.weights);
  const solve = useStudyStore((s) => s.solve);
  const potProvenance = provenanceHint(setupMeta, "pot");
  const stackProvenance = provenanceHint(setupMeta, "stack");
  const previewState = useTreePreviewPlan();
  const { plan } = previewState;

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
  const [treeCatalogueMode, setTreeCatalogueMode] = useState<
    "save" | "open" | null
  >(null);
  const paintPct = Math.round(paintWeight * 100);
  const [paintWeightDraft, setPaintWeightDraft] = useState(String(paintPct));
  const [jobMessage, setJobMessage] = useState<string | null>(null);
  const jobFileInputRef = useRef<HTMLInputElement>(null);
  const applyPortableJobJson = useStudyStore((s) => s.applyPortableJobJson);
  const exportPortableJobJson = useStudyStore((s) => s.exportPortableJobJson);

  useEffect(() => {
    setPaintWeightDraft(String(Math.round(paintWeight * 100)));
  }, [paintWeight]);

  const oopCombos = comboCount(weights.oop, draft.boardText);
  const ipCombos = comboCount(weights.ip, draft.boardText);

  const exportStudyJob = () => {
    try {
      const text = exportPortableJobJson();
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "study-job.json";
      a.click();
      URL.revokeObjectURL(url);
      setJobMessage("Exported study-job.json.");
    } catch (err) {
      setJobMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const onJobFileChosen = async (file: File | null) => {
    if (!file) return;
    try {
      const text = await file.text();
      const result = applyPortableJobJson(text);
      setJobMessage(
        result.ok
          ? result.warnings.length
            ? `Loaded job. ${result.warnings.join(" ")}`
            : "Loaded job into Build."
          : result.error,
      );
    } catch (err) {
      setJobMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const commitPaintWeightDraft = (raw: string) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      setPaintWeightDraft(String(Math.round(paintWeight * 100)));
      return;
    }
    const clampedPct = Math.max(0, Math.min(100, parsed));
    setPaintWeight(clampedPct / 100);
    setPaintWeightDraft(String(Math.round(clampedPct)));
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

  const runSolve = () => {
    void executeSolve({
      getContext: () =>
        studyCommandContextFromStore({
          ...useStudyStore.getState(),
          status: useStudyStore.getState().status,
        }),
      solve,
    });
  };

  return (
    <div className="build-workspace">
      <header className="build-header">
        <div>
          <h1>Build</h1>
          {setupMeta?.profile ? (
            <p className="build-profile-note">
              Profile {setupMeta.profile.displayName} (
              {setupMeta.profile.classification})
            </p>
          ) : null}
        </div>
        <div className="build-solve-bar">
          {plan ? (
            <MemoryPlanStrip plan={plan} pot={draft.pot} stack={draft.stack} />
          ) : (
            <span className="build-solve-bar__pending muted">Memory…</span>
          )}
          <button
            type="button"
            className="toolbar-btn primary"
            disabled={solveBlocked}
            title={solveGate.ok ? undefined : solveGate.reason}
            onClick={runSolve}
          >
            Solve
          </button>
          <button
            type="button"
            className="toolbar-btn"
            title="Export this Build as a portable study job"
            onClick={exportStudyJob}
          >
            Export job
          </button>
          <button
            type="button"
            className="toolbar-btn"
            title="Import a portable study job into this Build draft"
            onClick={() => jobFileInputRef.current?.click()}
          >
            Import job
          </button>
          <input
            ref={jobFileInputRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              event.target.value = "";
              void onJobFileChosen(file);
            }}
          />
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

      {jobMessage ? (
        <p className="build-profile-note" role="status">
          {jobMessage}
        </p>
      ) : null}

      {solveBlocked && solveErrors.length > 0 ? (
        <div className="build-solve-errors" role="alert">
          <ul>
            {solveErrors.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {treeCatalogueMode ? (
        <div
          className="catalogue-modal-overlay"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setTreeCatalogueMode(null);
            }
          }}
        >
          <div
            className="catalogue-modal catalogue-modal--tree"
            role="dialog"
            aria-modal="true"
            aria-label="Betting tree catalogue"
          >
            <div className="range-editor__head">
              <h2>Betting trees</h2>
              <button
                type="button"
                className="toolbar-btn"
                onClick={() => setTreeCatalogueMode(null)}
              >
                Close
              </button>
            </div>
            <BettingTreeCatalogue
              draft={draft}
              initialMode={treeCatalogueMode}
              onClose={() => setTreeCatalogueMode(null)}
              onOpen={(entry) => {
                updateDraft(entry.document.tree);
                setTreeCatalogueMode(null);
              }}
            />
          </div>
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

      <section className="build-section build-spot" aria-label="Spot">
        <div className="build-inline build-inline--scalar">
          <label>
            Board
            <input
              value={draft.boardText}
              onChange={(event) => updateDraft({ boardText: event.target.value })}
            />
          </label>
          <label>
            Pot{potProvenance ? ` · ${potProvenance}` : ""}
            <input
              type="number"
              value={draft.pot}
              onChange={(event) => updateDraft({ pot: Number(event.target.value) })}
            />
          </label>
          <label>
            Effective stack{stackProvenance ? ` · ${stackProvenance}` : ""}
            <input
              type="number"
              value={draft.stack}
              onChange={(event) => updateDraft({ stack: Number(event.target.value) })}
            />
          </label>
        </div>
        <div className="build-range-summaries" aria-label="Range summaries">
          <div className="build-range-summary">
            <h3 className="build-range-summary__seat">OOP range</h3>
            <span className="build-range-summary__count tabular">
              {formatComboCount(oopCombos)}
            </span>
            <span className="build-range-summary__text" title={draft.oopRange}>
              {draft.oopRange || "—"}
            </span>
          </div>
          <div className="build-range-summary">
            <h3 className="build-range-summary__seat">IP range</h3>
            <span className="build-range-summary__count tabular">
              {formatComboCount(ipCombos)}
            </span>
            <span className="build-range-summary__text" title={draft.ipRange}>
              {draft.ipRange || "—"}
            </span>
          </div>
        </div>
      </section>

      <div className="build-main">
        <section className="build-section build-ranges" aria-labelledby="build-ranges-title">
          <div className="build-subhead-row">
            <h2 id="build-ranges-title">Ranges</h2>
            <div className="range-toolbar">
              <label className="paint-weight-field">
                Paint weight
                <div className="paint-weight-controls">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={paintPct}
                    aria-label="Paint weight slider"
                    onChange={(event) =>
                      setPaintWeight(Number(event.target.value) / 100)
                    }
                  />
                  <input
                    type="number"
                    className="paint-weight-input tabular"
                    min={0}
                    max={100}
                    step={1}
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
                  <span className="paint-weight-unit" aria-hidden="true">
                    %
                  </span>
                </div>
              </label>
              <button
                type="button"
                className="toolbar-btn"
                disabled={!canUndoRange}
                onClick={undoRange}
              >
                Undo
              </button>
              <button
                type="button"
                className="toolbar-btn"
                disabled={!canRedoRange}
                onClick={redoRange}
              >
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

        <section
          className="build-section build-betting-tree"
          aria-labelledby="build-tree-title"
        >
          <div className="build-subhead-row">
            <h2 id="build-tree-title">Betting tree</h2>
            <div className="build-subhead-actions">
              <button
                type="button"
                className="toolbar-btn"
                onClick={() => setTreeCatalogueMode("save")}
              >
                Save tree
              </button>
              <button
                type="button"
                className="toolbar-btn"
                onClick={() => setTreeCatalogueMode("open")}
              >
                Open tree
              </button>
            </div>
          </div>

          <div className="build-tree-grid" role="table" aria-label="Street sizes">
            <div className="build-tree-grid__head" role="row">
              <span role="columnheader" />
              <span role="columnheader">OOP</span>
              <span role="columnheader">IP</span>
            </div>
            {(
              [
                ["Flop bets", "Flop OOP bets", "Flop IP bets", "oopFlop", "ipFlop"],
                [
                  "Flop raises",
                  "Flop OOP raises",
                  "Flop IP raises",
                  "oopFlopRaises",
                  "ipFlopRaises",
                ],
                ["Turn bets", "Turn OOP bets", "Turn IP bets", "oopTurn", "ipTurn"],
                [
                  "Turn raises",
                  "Turn OOP raises",
                  "Turn IP raises",
                  "oopTurnRaises",
                  "ipTurnRaises",
                ],
                [
                  "River bets",
                  "River OOP bets",
                  "River IP bets",
                  "oopRiver",
                  "ipRiver",
                ],
                [
                  "River raises",
                  "River OOP raises",
                  "River IP raises",
                  "oopRiverRaises",
                  "ipRiverRaises",
                ],
              ] as const
            ).map(([rowLabel, oopLabel, ipLabel, oopKey, ipKey]) => (
              <div key={rowLabel} className="build-tree-grid__row" role="row">
                <span className="build-tree-grid__row-label" role="rowheader">
                  {rowLabel}
                </span>
                <SizeField
                  label={oopLabel}
                  hideCaption
                  value={draft[oopKey]}
                  onChange={(next) => updateDraft({ [oopKey]: next })}
                />
                <SizeField
                  label={ipLabel}
                  hideCaption
                  value={draft[ipKey]}
                  onChange={(next) => updateDraft({ [ipKey]: next })}
                />
              </div>
            ))}
          </div>

          <h3 className="build-subhead">Donk</h3>
          <div className="build-inline">
            <SizeField
              label="Turn donk"
              value={draft.oopTurnDonk}
              onChange={(next) => updateDraft({ oopTurnDonk: next })}
            />
            <SizeField
              label="River donk"
              value={draft.oopRiverDonk}
              onChange={(next) => updateDraft({ oopRiverDonk: next })}
            />
          </div>

          <h3 className="build-subhead">Thresholds</h3>
          <div className="build-inline build-inline--scalar">
            <label>
              Max raises
              <input
                type="number"
                value={draft.maxRaises}
                onChange={(event) =>
                  updateDraft({ maxRaises: Number(event.target.value) })
                }
              />
            </label>
            <label>
              Pot cap
              <input
                type="number"
                value={draft.potCap}
                onChange={(event) =>
                  updateDraft({ potCap: Number(event.target.value) })
                }
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
            <label>
              All-in threshold (%)
              <input
                type="number"
                value={
                  Number.isFinite(draft.allInThreshold)
                    ? draft.allInThreshold * 100
                    : 0
                }
                onChange={(event) =>
                  updateDraft({
                    allInThreshold: Number(event.target.value) / 100,
                  })
                }
              />
            </label>
          </div>

          <h3 className="build-subhead">Stopping</h3>
          <div className="build-inline build-inline--scalar">
            <label>
              Iterations
              <input
                type="number"
                value={draft.iterations}
                onChange={(event) =>
                  updateDraft({ iterations: Number(event.target.value) })
                }
              />
            </label>
            <label>
              Accuracy (%)
              <input
                value={draft.accuracy}
                placeholder="off"
                title="Stop when Pio Accuracy ≤ this percent of the pot (0.5 = 0.5% pot)"
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
      </div>

      <TreeLineEditor previewState={previewState} />
    </div>
  );
}
