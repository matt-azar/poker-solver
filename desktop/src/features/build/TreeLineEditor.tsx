import { useEffect, useMemo, useState } from "react";
import {
  abbreviateActionLine,
  potFacingAfterPath,
} from "../../domain/actionHistory";
import { formatActionDisplay } from "../../domain/betSizes";
import type {
  MemoryPlanPayload,
  TreePreviewAction,
  TreePreviewNode,
} from "../../domain/types";
import { useStudyStore } from "../../state/studyStore";
import { useTreePreviewPlan } from "./useTreePreviewPlan";

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1048576) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / 1048576).toFixed(1)} MiB`;
}

function MemoryPlanStrip({
  plan,
  pot,
  stack,
}: {
  plan: MemoryPlanPayload;
  pot: number;
  stack: number;
}) {
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

function actionKey(nodeIndex: number, compact: string): string {
  return `${nodeIndex}:${compact}`;
}

/** Follow chance links to the next decision (or null at a terminal). */
function nextDecision(
  nodes: TreePreviewNode[],
  startIndex: number,
): TreePreviewNode | null {
  let index = startIndex;
  const guard = nodes.length + 2;
  for (let i = 0; i < guard; i += 1) {
    const node = nodes[index];
    if (!node) {
      return null;
    }
    if (node.terminal) {
      return null;
    }
    if (!node.chance) {
      return node;
    }
    if (node.chance_child < 0) {
      return null;
    }
    index = node.chance_child;
  }
  return null;
}

function TreeActionBranch({
  nodes,
  node,
  action,
  rootPot,
  selectedKey,
  onSelect,
  onForce,
  onRemove,
  onAddSize,
}: {
  nodes: TreePreviewNode[];
  node: TreePreviewNode;
  action: TreePreviewAction;
  rootPot: number;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onForce: (path: string, compact: string) => void;
  onRemove: (path: string, compact: string) => void;
  onAddSize: (path: string) => void;
}) {
  const key = actionKey(node.index, action.compact);
  const selected = selectedKey === key;
  const { pot, toCall } = potFacingAfterPath(node.path, rootPot);
  // Raise tags size against pot+call (same basis as Study action blocks).
  const sizePot = toCall > 0 ? pot + toCall : pot;
  const display = formatActionDisplay(action.label, sizePot, "pot", { toCall });
  const child = nextDecision(nodes, action.child_index);

  return (
    <li className="tree-diagram-branch">
      <div className="tree-diagram-edge" aria-hidden="true" />
      <div
        className="tree-diagram-action"
        data-selected={selected ? "true" : undefined}
      >
        <button
          type="button"
          className="tree-diagram-action-btn"
          title={display.raw}
          aria-pressed={selected}
          onClick={() => onSelect(selected ? "" : key)}
        >
          <span className="tree-diagram-dot" aria-hidden="true" />
          <span className="tree-diagram-label">{display.primary}</span>
        </button>
        {selected ? (
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
            <button
              type="button"
              className="toolbar-btn"
              title="Add a bet/raise size at this decision"
              onClick={() => onAddSize(node.path)}
            >
              Add size…
            </button>
          </span>
        ) : null}
      </div>
      {child ? (
        <DecisionBranch
          nodes={nodes}
          node={child}
          rootPot={rootPot}
          selectedKey={selectedKey}
          onSelect={onSelect}
          onForce={onForce}
          onRemove={onRemove}
          onAddSize={onAddSize}
        />
      ) : null}
    </li>
  );
}

function DecisionBranch({
  nodes,
  node,
  rootPot,
  selectedKey,
  onSelect,
  onForce,
  onRemove,
  onAddSize,
}: {
  nodes: TreePreviewNode[];
  node: TreePreviewNode;
  rootPot: number;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onForce: (path: string, compact: string) => void;
  onRemove: (path: string, compact: string) => void;
  onAddSize: (path: string) => void;
}) {
  // Nested decisions start collapsed so the diagram is navigable from the root.
  const [expanded, setExpanded] = useState(false);
  const seat = node.player === 0 ? "OOP" : node.player === 1 ? "IP" : "—";
  const headLabel = `${seat} · street ${node.street}${
    node.path ? ` · ${abbreviatePathForMeta(node.path, rootPot)}` : " · root"
  }`;
  const hasChildren = node.actions.length > 0;

  return (
    <div
      className="tree-diagram-decision"
      data-street={node.street}
      data-expanded={expanded ? "true" : "false"}
    >
      <div className="tree-diagram-decision-head">
        {hasChildren ? (
          <button
            type="button"
            className="tree-diagram-expand"
            aria-expanded={expanded}
            aria-label={expanded ? `Collapse ${headLabel}` : `Expand ${headLabel}`}
            onClick={() => setExpanded((value) => !value)}
          >
            <span className="tree-meta">{headLabel}</span>
          </button>
        ) : (
          <span className="tree-meta">{headLabel}</span>
        )}
      </div>
      {expanded && hasChildren ? (
        <ul className="tree-diagram-children" role="group">
          {node.actions.map((action) => (
            <TreeActionBranch
              key={`${node.index}-${action.compact}`}
              nodes={nodes}
              node={node}
              action={action}
              rootPot={rootPot}
              selectedKey={selectedKey}
              onSelect={onSelect}
              onForce={onForce}
              onRemove={onRemove}
              onAddSize={onAddSize}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function abbreviatePathForMeta(path: string, rootPot: number): string {
  return abbreviateActionLine(path, rootPot);
}

interface TreeLineEditorProps {
  /** When true, Build header owns the MemoryPlanStrip (avoids duplicate chrome). */
  hideMemoryStrip?: boolean;
  /** Notify Build header of the latest memory plan from the single tree_preview poll. */
  onPlanChange?: (plan: MemoryPlanPayload | null) => void;
}

export function TreeLineEditor({
  hideMemoryStrip = false,
  onPlanChange,
}: TreeLineEditorProps = {}) {
  const draft = useStudyStore((s) => s.draft);
  const updateDraft = useStudyStore((s) => s.updateDraft);
  const { preview, plan, error, busy, refresh } = useTreePreviewPlan();
  const [open, setOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [addSizePath, setAddSizePath] = useState<string | null>(null);
  const [addSizeValue, setAddSizeValue] = useState("0.33");

  useEffect(() => {
    onPlanChange?.(plan);
  }, [plan, onPlanChange]);

  const appendEdit = (line: string) => {
    if (draft.treeEdits.includes(line)) {
      return;
    }
    updateDraft({ treeEdits: [...draft.treeEdits, line] });
  };

  const removeEditAt = (index: number) => {
    updateDraft({ treeEdits: draft.treeEdits.filter((_, i) => i !== index) });
  };

  const rootDecision = useMemo(() => {
    if (!preview?.nodes.length) {
      return null;
    }
    return (
      preview.nodes.find((node) => !node.terminal && !node.chance && node.path === "") ??
      preview.nodes.find((node) => !node.terminal && !node.chance) ??
      null
    );
  }, [preview]);

  return (
    <section className="build-section tree-editor" data-span="2" aria-label="Advanced tree">
      {!hideMemoryStrip && plan ? (
        <MemoryPlanStrip plan={plan} pot={draft.pot} stack={draft.stack} />
      ) : null}
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
          {error ? <p className="tree-editor-error">{error}</p> : null}
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
          {rootDecision && preview ? (
            <div className="tree-diagram" role="tree">
              <DecisionBranch
                nodes={preview.nodes}
                node={rootDecision}
                rootPot={draft.pot}
                selectedKey={selectedKey}
                onSelect={(key) => setSelectedKey(key || null)}
                onForce={(path, compact) => appendEdit(forceLine(path, compact))}
                onRemove={(path, compact) => appendEdit(removeLine(path, compact))}
                onAddSize={(path) => {
                  setAddSizePath(path);
                  setAddSizeValue("0.33");
                }}
              />
            </div>
          ) : !error && !busy ? (
            <p className="empty-hint">No decision nodes in this preview.</p>
          ) : null}
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
      ) : null}
    </section>
  );
}
