import {
  actorLabel,
  boardCardList,
  nodeStatusLabel,
  streetFromPlace,
} from "../../domain/actionHistory";
import { useStudyStore } from "../../state/studyStore";
import "../../styles/path-nav.css";

/**
 * Demoted tree diagnostics panel.
 *
 * Path chrome (ActionHistory) owns line navigation, Next choices, and
 * back/forward. This panel keeps optional node metadata without a competing
 * raw-ID child list. Node ids stay in tooltips / the diagnostics row only.
 */
export function NodeNavigator() {
  const currentNode = useStudyStore((s) => s.currentNode);
  const rootId = useStudyStore((s) => s.status?.root_node_id || "p0.t-1.r-1");
  const pathTrail = useStudyStore((s) => s.pathTrail);
  const layout = useStudyStore((s) => s.layout);
  const navigateTo = useStudyStore((s) => s.navigateTo);
  const setLayout = useStudyStore((s) => s.setLayout);

  if (!layout.leftNav) {
    return null;
  }

  const place =
    typeof currentNode?.place === "string" ? currentNode.place : null;
  const board = boardCardList(currentNode?.board);
  const street = streetFromPlace(place, board.length);
  const playerLabel = currentNode
    ? currentNode.kind === "chance"
      ? "Deal"
      : currentNode.kind === "terminal"
        ? nodeStatusLabel(currentNode)
        : actorLabel(currentNode.to_act, currentNode.player ?? null)
    : "—";
  const parentId =
    typeof currentNode?.parent_id === "string" ? currentNode.parent_id : null;
  const trailDepth = pathTrail.length;
  const hasPathChrome = Boolean(currentNode);

  return (
    <nav
      className="node-navigator node-navigator--diagnostics"
      aria-label="Node diagnostics"
    >
      <div className="node-navigator__head">
        <span>Diagnostics</span>
        <button
          type="button"
          className="icon-btn"
          title="Hide diagnostics"
          onClick={() => setLayout({ leftNav: false })}
        >
          ×
        </button>
      </div>
      <div className="node-navigator__list">
        {hasPathChrome ? (
          <p className="node-navigator__hint">
            Path navigation lives in the Path strip. This panel is optional
            diagnostics — raw node ids are not listed as a second navigator.
          </p>
        ) : (
          <p className="empty-hint">No node loaded</p>
        )}
        <div className="node-navigator__diag">
          <div className="node-navigator__diag-row">
            <span className="muted">Street</span>
            <strong>{street}</strong>
          </div>
          <div className="node-navigator__diag-row">
            <span className="muted">Kind</span>
            <strong>{currentNode?.kind ?? "—"}</strong>
          </div>
          <div className="node-navigator__diag-row">
            <span className="muted">Player / status</span>
            <strong>{playerLabel}</strong>
          </div>
          <div className="node-navigator__diag-row">
            <span className="muted">Trail depth</span>
            <strong className="tabular">{trailDepth}</strong>
          </div>
          <div className="node-navigator__diag-row">
            <span className="muted">Node id</span>
            <button
              type="button"
              className="node-navigator__id"
              title={currentNode?.node_id || rootId}
              onClick={() => {
                const id = currentNode?.node_id || rootId;
                void navigateTo(id);
              }}
            >
              {currentNode?.node_id
                ? `${currentNode.node_id.slice(0, 18)}${
                    currentNode.node_id.length > 18 ? "…" : ""
                  }`
                : "—"}
            </button>
          </div>
          {parentId ? (
            <div className="node-navigator__diag-row">
              <span className="muted">Parent id</span>
              <button
                type="button"
                className="node-navigator__id"
                title={parentId}
                onClick={() => void navigateTo(parentId)}
              >
                {`${parentId.slice(0, 18)}${parentId.length > 18 ? "…" : ""}`}
              </button>
            </div>
          ) : (
            <div className="node-navigator__diag-row">
              <span className="muted">Parent id</span>
              <strong title="parent_id missing on this payload — client pathTrail remains authoritative for alternatives">
                unavailable
              </strong>
            </div>
          )}
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => void navigateTo(rootId)}
          >
            Jump to Root
          </button>
        </div>
      </div>
    </nav>
  );
}
