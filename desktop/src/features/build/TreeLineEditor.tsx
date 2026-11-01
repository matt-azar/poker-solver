import { useEffect, useRef, useState } from "react";
import { engineClient, EngineError } from "../../engine/client";
import type {
  MemoryPlanPayload,
  SpotDraft,
  TreePreviewNode,
  TreePreviewPayload,
} from "../../domain/types";
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

function draftPreviewBody(draft: SpotDraft) {
  const board = draft.boardText
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  return {
    board,
    oop_range: draft.oopRange,
    ip_range: draft.ipRange,
    pot: draft.pot,
    stack: draft.stack,
    oop_bets: draft.oopBets
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n)),
    ip_bets: draft.ipBets
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n)),
    oop_flop_bets: draft.oopFlop
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n)),
    ip_flop_bets: draft.ipFlop
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n)),
    oop_turn_bets: draft.oopTurn
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n)),
    ip_turn_bets: draft.ipTurn
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n)),
    oop_river_bets: draft.oopRiver
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n)),
    ip_river_bets: draft.ipRiver
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n)),
    oop_donk: draft.oopDonk
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n)),
    pot_cap: draft.potCap || 0,
    allow_three_bet: draft.noThreeBet ? 0 : 1,
    geometric: draft.geometric ? 1 : 0,
    all_in_threshold: draft.allInThreshold || 0,
    allow_all_in: draft.allowAllIn ? 1 : 0,
    max_raises: draft.maxRaises,
    iterations: 1,
    memory_mib: draft.memoryMib,
    threads: draft.threads,
    tree_edits: draft.treeEdits.length > 0 ? draft.treeEdits : undefined,
  };
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

export function TreeLineEditor() {
  const draft = useStudyStore((s) => s.draft);
  const updateDraft = useStudyStore((s) => s.updateDraft);
  const [preview, setPreview] = useState<TreePreviewPayload | null>(null);
  const [plan, setPlan] = useState<MemoryPlanPayload | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [addSizePath, setAddSizePath] = useState<string | null>(null);
  const [addSizeValue, setAddSizeValue] = useState("0.33");
  const requestId = useRef(0);

  const refresh = async () => {
    const id = ++requestId.current;
    setBusy(true);
    setError("");
    try {
      const body = draftPreviewBody(draft);
      const [tree, memory] = await Promise.all([
        engineClient.treePreview(body),
        engineClient.planMemory(body),
      ]);
      if (id !== requestId.current) {
        return;
      }
      setPreview(tree);
      setPlan(memory);
    } catch (err) {
      if (id !== requestId.current) {
        return;
      }
      const message =
        err instanceof EngineError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Tree preview failed";
      setError(message);
    } finally {
      if (id === requestId.current) {
        setBusy(false);
      }
    }
  };

  useEffect(() => {
    const handle = window.setTimeout(() => {
      void refresh();
    }, 350);
    return () => window.clearTimeout(handle);
    // Spot + bet + edit fields that reshape the public tree.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    draft.boardText,
    draft.oopRange,
    draft.ipRange,
    draft.pot,
    draft.stack,
    draft.oopBets,
    draft.ipBets,
    draft.oopFlop,
    draft.ipFlop,
    draft.oopTurn,
    draft.ipTurn,
    draft.oopRiver,
    draft.ipRiver,
    draft.oopDonk,
    draft.potCap,
    draft.noThreeBet,
    draft.geometric,
    draft.allInThreshold,
    draft.allowAllIn,
    draft.maxRaises,
    draft.memoryMib,
    draft.threads,
    draft.treeEdits,
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
        <h2>Line editor</h2>
        <button type="button" className="toolbar-btn" disabled={busy} onClick={() => void refresh()}>
          {busy ? "Refreshing…" : "Refresh preview"}
        </button>
      </div>
      <p className="tree-editor-help">
        Preview uses canonical action labels. Force / Remove / Add size write{" "}
        <code>tree-edit</code> lines into the draft; Solve rebuilds the tree from them.
      </p>
      {error ? <p className="tree-editor-error">{error}</p> : null}
      {plan ? (
        <div className="memory-plan" title="estimated_peak_bytes is a labeled plan, not RSS">
          <span>
            Plan peak {formatBytes(plan.estimated_peak_bytes)}
            {plan.fits_budget ? "" : " (over budget)"}
          </span>
          <span>
            Budget {formatBytes(plan.memory_budget_bytes)} · {plan.public_decisions} decisions ·{" "}
            {plan.deals} deals
          </span>
          <span className="tree-meta">
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
          <button type="button" className="toolbar-btn" onClick={() => setAddSizePath(null)}>
            Cancel
          </button>
        </div>
      ) : null}
    </section>
  );
}
