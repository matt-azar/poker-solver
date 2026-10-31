import type { NodeActionChild, NodeCardChild } from "../../domain/types";
import { useStudyStore } from "../../state/studyStore";

function labelOf(child: NodeActionChild | NodeCardChild | string): string {
  if (typeof child === "string") {
    return child;
  }
  if ("card" in child && child.card) {
    return child.card;
  }
  if ("label" in child && child.label) {
    return child.label;
  }
  if ("action" in child && child.action) {
    return child.action;
  }
  return "child";
}

function nodeIdOf(child: NodeActionChild | NodeCardChild | string): string | null {
  if (typeof child === "string") {
    return child;
  }
  return child.node_id ?? null;
}

export function NodeNavigator() {
  const currentNode = useStudyStore((s) => s.currentNode);
  const rootId = useStudyStore((s) => s.status?.root_node_id || "p0.t-1.r-1");
  const layout = useStudyStore((s) => s.layout);
  const navigateTo = useStudyStore((s) => s.navigateTo);
  const followAction = useStudyStore((s) => s.followAction);
  const setLayout = useStudyStore((s) => s.setLayout);

  if (!layout.leftNav) {
    return null;
  }

  const children = currentNode?.children ?? [];
  const playerLabel =
    currentNode?.player == null
      ? currentNode?.to_act || "—"
      : currentNode.player === 0
        ? "OOP"
        : "IP";

  return (
    <nav className="node-navigator" aria-label="Line navigator">
      <div className="node-navigator__head">
        <span>Navigator</span>
        <button
          type="button"
          className="icon-btn"
          title="Hide navigator"
          onClick={() => setLayout({ leftNav: false })}
        >
          ×
        </button>
      </div>
      <div className="node-navigator__list">
        <button
          type="button"
          className="nav-node"
          onClick={() => void navigateTo(rootId)}
        >
          <span>Root</span>
        </button>
        {currentNode ? (
          <button
            type="button"
            className="nav-node"
            data-active="true"
            onClick={() => void navigateTo(currentNode.node_id)}
          >
            <span>{currentNode.node_id}</span>
          </button>
        ) : (
          <p className="empty-hint">No node loaded</p>
        )}
        <div className="node-navigator__meta">
          <div>
            <span className="muted">Player</span>
            <strong>{playerLabel}</strong>
          </div>
          <div>
            <span className="muted">Kind</span>
            <strong>{currentNode?.kind ?? "—"}</strong>
          </div>
        </div>
        {children.map((child, index) => {
          const id = nodeIdOf(child);
          const label = labelOf(child);
          const freq =
            typeof child === "object" && child && "frequency" in child
              ? child.frequency
              : null;
          return (
            <button
              key={`${label}-${index}`}
              type="button"
              className="nav-node"
              disabled={!id}
              onClick={() => id && void followAction(id)}
            >
              <span>{label}</span>
              {freq != null ? (
                <span className="nav-freq">{(freq * 100).toFixed(0)}%</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
