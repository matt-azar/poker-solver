import { useEffect, useRef, useState } from "react";
import { engineClient, EngineError } from "../../engine/client";
import type {
  MemoryPlanPayload,
  SpotDraft,
  TreePreviewNode,
  TreePreviewPayload,
} from "../../domain/types";
import { buildJob } from "../../state/studyDraft";
import { useStudyStore } from "../../state/studyStore";

/** Display labels → compact TreeEdit tokens (no spaces) for street-config text. */
function compactLabel(label: string): string {
  if (label === "Fold") return "f";
  if (label === "Check") return "c";
  if (label === "Call") return "call";
  let core = label;
  let allIn = false;
  if (core.endsWith(" all-in")) {
    allIn = true;
    core = core.slice(0, -" all-in".length);
  }
  if (core.startsWith("Bet ")) {
    return `b${core.slice(4)}${allIn ? "ai" : ""}`;
  }
  if (core.startsWith("Raise to ")) {
    return `r${core.slice("Raise to ".length)}${allIn ? "ai" : ""}`;
  }
  return label.replaceAll(" ", "");
}

function pathToken(displayPath: string): string {
  if (displayPath.trim() === "") {
    return "-";
  }
  return displayPath
    .split("/")
    .map((step) => compactLabel(step))
    .join("/");
}

function forceLine(path: string, compact: string): string {
  return `force ${pathToken(path)} ${compact}`;
}

function removeLine(path: string, compact: string): string {
  return `remove ${pathToken(path)} ${compact}`;
}

function addSizeLine(path: string, sizeText: string): string {
  return `add-size ${pathToken(path)} ${sizeText}`;
}

/** Same serializer Solve uses — preview and solve share board, ranges, sizes, edits, stop. */
function draftPreviewBody(draft: SpotDraft) {
  return buildJob(draft);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1048576) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / 1048576).toFixed(1)} MiB`;
}

function DecisionRow({
  node,
  onForce,
  onRemove,
  onAddSize,
}: {
  node: TreePreviewNode;
  onForce: (path: string, compact: string) => void;
  onRemove: (path: string, compact: string) => void;
  onAddSize: (path: string) => void;
}) {
  const seat = node.player === 0 ? "OOP" : node.player === 1 ? "IP" : "—";
  const pathLabel = node.path === "" ? "(root)" : node.path;
  return (
    <li className="tree-node" data-street={node.street}>
      <div className="tree-node-head">
        <span className="tree-path tabular">{pathLabel}</span>
        <span className="tree-meta">
          {seat} · street {node.street}
        </span>
      </div>
      <ul className="tree-actions">
        {node.actions.map((action) => (
          <li key={`${node.index}-${action.compact}`}>
            <span className="tree-action-label">
              {action.label} <code>{action.compact}</code>
            </span>
            <span className="tree-action-btns">
              <button
                type="button"
                className="toolbar-btn"
                title="Force this action at this decision"
                onClick={() => onForce(node.path, action.compact)}
              >
                Force
              </button>
              <button
                type="button"
                className="toolbar-btn"
                title="Remove this action at this decision"
                onClick={() => onRemove(node.path, action.compact)}
              >
                Remove
              </button>
            </span>
          </li>
        ))}
      </ul>
      <div className="tree-add-size">
        <button
          type="button"
          className="toolbar-btn"
          onClick={() => onAddSize(node.path)}
        >
          Add size…
        </button>
      </div>
    </li>
  );
}

/** Phases where Build must not issue tree_preview (ZR-158 stdin starvation). */
function previewBlockedPhase(phase: string): boolean {
  return (
    phase === "building" ||
    phase === "solving" ||
    phase === "pause_requested" ||
    phase === "stop_requested"
  );
}

export function TreeLineEditor() {
  const draft = useStudyStore((s) => s.draft);
  const phase = useStudyStore((s) => s.phase);
  const updateDraft = useStudyStore((s) => s.updateDraft);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<TreePreviewPayload | null>(null);
  const [plan, setPlan] = useState<MemoryPlanPayload | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [addSizePath, setAddSizePath] = useState<string | null>(null);
  const [addSizeValue, setAddSizeValue] = useState("0.33");
  const requestId = useRef(0);
  /** Bumps when the draft that shapes the tree changes — clears stale preview. */
  const draftRevision = useRef(0);

  const clearStalePreview = () => {
    draftRevision.current += 1;
    setPreview(null);
    setPlan(null);
    setError("");
  };

  const refresh = async () => {
    // Host tree_preview is still sync on the sidecar stdin loop. Issuing it while
    // Solve/begin owns the engine starves status polls → "Solve failed." (ZR-158).
    if (previewBlockedPhase(useStudyStore.getState().phase)) {
      return;
    }
    const id = ++requestId.current;
    const revision = draftRevision.current;
    setBusy(true);
    setError("");
    try {
      const body = draftPreviewBody(draft);
      // One plan-only construction returns nodes + labeled memory plan.
      const tree = await engineClient.treePreview(body);
      if (id !== requestId.current || revision !== draftRevision.current) {
        return;
      }
      setPreview(tree);
      setPlan(tree.plan ?? null);
    } catch (err) {
      if (id !== requestId.current || revision !== draftRevision.current) {
        return;
      }
      const message =
        err instanceof EngineError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Tree preview failed";
      // Failed preview must not touch the live Study solution — only local UI.
      setError(message);
      setPreview(null);
      setPlan(null);
    } finally {
      if (id === requestId.current) {
        setBusy(false);
      }
    }
  };

  useEffect(() => {
    clearStalePreview();
    if (previewBlockedPhase(phase)) {
      return;
    }
    const handle = window.setTimeout(() => {
      void refresh();
    }, 350);
    return () => window.clearTimeout(handle);
    // Spot + bet + edit fields that reshape the public tree / memory plan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    phase,
    draft.boardText,
    draft.oopRange,
    draft.ipRange,
    draft.pot,
    draft.stack,
    draft.oopBets,
    draft.ipBets,
    draft.oopRaises,
    draft.ipRaises,
    draft.oopFlop,
    draft.ipFlop,
    draft.oopTurn,
    draft.ipTurn,
    draft.oopRiver,
    draft.ipRiver,
    draft.oopFlopRaises,
    draft.ipFlopRaises,
    draft.oopTurnRaises,
    draft.ipTurnRaises,
    draft.oopRiverRaises,
    draft.ipRiverRaises,
    draft.oopDonk,
    draft.oopFlopDonk,
    draft.oopTurnDonk,
    draft.oopRiverDonk,
    draft.donkFlop,
    draft.donkTurn,
    draft.donkRiver,
    draft.mergeThresholdPct,
    draft.potCap,
    draft.noThreeBet,
    draft.allInThreshold,
    draft.maxRaises,
    draft.memoryMib,
    draft.threads,
    draft.treeEdits,
    draft.iterations,
    draft.accuracy,
    draft.timeLimit,
    draft.algorithm,
    draft.samples,
    draft.rakeRate,
    draft.rakeCap,
    draft.useIcm,
    draft.icmStacks,
    draft.icmPayouts,
    draft.incentives,
    draft.edgeTags,
  ]);

  const appendEdit = (line: string) => {
    if (draft.treeEdits.includes(line)) {
      return;
    }
    updateDraft({ treeEdits: [...draft.treeEdits, line] });
  };

  const removeEditAt = (index: number) => {
    updateDraft({ treeEdits: draft.treeEdits.filter((_, i) => i !== index) });
  };

  const decisions =
    preview?.nodes.filter((node) => !node.terminal && !node.chance) ?? [];

  return (
    <section className="build-section tree-editor" data-span="2">
      <div className="panel-title-row">
        <h2>
          <button
            type="button"
            className="tree-editor-toggle"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            Preview tree
          </button>
        </h2>
        {open ? (
          <button
            type="button"
            className="toolbar-btn"
            disabled={busy}
            onClick={() => void refresh()}
          >
            {busy ? "Refreshing…" : "Refresh preview"}
          </button>
        ) : null}
      </div>
      {open ? (
        <>
          <p className="tree-editor-help">
            Shows effective legal actions after chip rounding, capping, and merging,
            plus the labeled engine heap plan against the budget. Force / Remove / Add
            size write <code>tree-edit</code> lines into the draft; Solve rebuilds from
            the same draft serializer.
          </p>
          {error ? <p className="tree-editor-error">{error}</p> : null}
          {plan ? (
            <div
              className="memory-plan"
              data-over-budget={plan.fits_budget ? undefined : "true"}
              title="estimated_peak_bytes is a labeled plan, not RSS"
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
                pot {draft.pot} · stack {draft.stack} ·{" "}
                {plan.dry_run ? "dry-run plan" : "plan"} · not process RSS
              </span>
            </div>
          ) : null}
          {draft.treeEdits.length > 0 ? (
            <div className="tree-edits-list">
              <div className="panel-title-row">
                <h3>Applied edits</h3>
                <button
                  type="button"
                  className="toolbar-btn"
                  onClick={() => updateDraft({ treeEdits: [] })}
                >
                  Clear edits
                </button>
              </div>
              <ul>
                {draft.treeEdits.map((line, index) => (
                  <li key={`${line}-${index}`}>
                    <code>{line}</code>
                    <button
                      type="button"
                      className="toolbar-btn"
                      onClick={() => removeEditAt(index)}
                    >
                      Drop
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <ul className="tree-preview">
            {decisions.map((node) => (
              <DecisionRow
                key={node.index}
                node={node}
                onForce={(path, compact) => appendEdit(forceLine(path, compact))}
                onRemove={(path, compact) => appendEdit(removeLine(path, compact))}
                onAddSize={(path) => {
                  setAddSizePath(path);
                  setAddSizeValue("0.33");
                }}
              />
            ))}
          </ul>
          {addSizePath !== null ? (
            <div className="tree-add-dialog">
              <label>
                Size at {addSizePath === "" ? "root" : addSizePath}
                <input
                  value={addSizeValue}
                  onChange={(event) => setAddSizeValue(event.target.value)}
                  placeholder="0.33 or 20c"
                />
              </label>
              <button
                type="button"
                className="toolbar-btn primary"
                onClick={() => {
                  const trimmed = addSizeValue.trim();
                  if (trimmed) {
                    appendEdit(addSizeLine(addSizePath, trimmed));
                  }
                  setAddSizePath(null);
                }}
              >
                Add size
              </button>
              <button
                type="button"
                className="toolbar-btn"
                onClick={() => setAddSizePath(null)}
              >
                Cancel
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <p className="tree-editor-help">
          Expand to preview legal actions, memory plan, and line edits before Solve.
        </p>
      )}
    </section>
  );
}
