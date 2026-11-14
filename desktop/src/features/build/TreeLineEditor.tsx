import { useEffect, useMemo, useRef, useState } from "react";
import {
  abbreviateActionLine,
  potFacingAfterPath,
} from "../../domain/actionHistory";
import { formatActionDisplay } from "../../domain/betSizes";
import { engineClient, EngineError } from "../../engine/client";
import type {
  MemoryPlanPayload,
  SpotDraft,
  TreePreviewAction,
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
        pot {pot} · stack {stack} · {plan.dry_run ? "dry-run plan" : "plan"} · not
        process RSS
      </span>
    </div>
  );
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
  const seat = node.player === 0 ? "OOP" : node.player === 1 ? "IP" : "—";
  return (
    <div className="tree-diagram-decision" data-street={node.street}>
      <div className="tree-diagram-decision-head">
        <span className="tree-meta">
          {seat} · street {node.street}
          {node.path ? ` · ${abbreviatePathForMeta(node.path, rootPot)}` : " · root"}
        </span>
      </div>
      <ul className="tree-diagram-children">
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
    </div>
  );
}

function abbreviatePathForMeta(path: string, rootPot: number): string {
  return abbreviateActionLine(path, rootPot);
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
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
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
    setSelectedKey(null);
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
    <section className="build-section tree-editor" data-span="2">
      {plan ? (
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
          <p className="tree-editor-help">
            Click a node for Force / Remove / Add size. Labels are pot-% tags
            (`b50` = 50% of the pot before the bet). Edits write{" "}
            <code>tree-edit</code> lines into the draft; Solve rebuilds from the
            same draft serializer.
          </p>
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
            <p className="tree-editor-help">No decision nodes in this preview.</p>
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
      ) : (
        <p className="tree-editor-help">
          Expand to preview legal actions and line edits before Solve.
        </p>
      )}
    </section>
  );
}
