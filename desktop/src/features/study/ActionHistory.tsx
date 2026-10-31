import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { NodeActionChild, NodeCardChild } from "../../domain/types";
import { useStudyStore } from "../../state/studyStore";

function isActionChild(
  child: NodeActionChild | NodeCardChild | string,
): child is NodeActionChild {
  return typeof child === "object" && child !== null && ("action" in child || "label" in child);
}

export function ActionHistory() {
  const currentNode = useStudyStore((s) => s.currentNode);
  const layout = useStudyStore((s) => s.layout);
  const setLayout = useStudyStore((s) => s.setLayout);
  const navigateTo = useStudyStore((s) => s.navigateTo);
  const followAction = useStudyStore((s) => s.followAction);

  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      event.preventDefault();
      dragRef.current = { startY: event.clientY, startH: layout.historyHeight };
      const onMove = (ev: PointerEvent) => {
        if (!dragRef.current) {
          return;
        }
        const next = Math.min(
          280,
          Math.max(64, dragRef.current.startH + (ev.clientY - dragRef.current.startY)),
        );
        setLayout({ historyHeight: next });
      };
      const onUp = () => {
        dragRef.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [layout.historyHeight, setLayout],
  );

  const children = currentNode?.children ?? [];
  const line = currentNode?.line;

  return (
    <section className="action-history" style={{ height: layout.historyHeight }}>
      <div className="action-history__head">
        <span>Action history</span>
        <span>{line || "No line"}</span>
      </div>
      <div className="action-history__list">
        {currentNode?.node_id ? (
          <button
            type="button"
            className="history-chip"
            data-active="true"
            onClick={() => void navigateTo(currentNode.node_id)}
          >
            {currentNode.node_id}
          </button>
        ) : (
          <span className="empty-hint">Solve a spot to browse the tree.</span>
        )}
        {children.map((child, index) => {
          if (typeof child === "string") {
            return (
              <button
                key={`${child}-${index}`}
                type="button"
                className="history-chip"
                onClick={() => void followAction(child)}
              >
                {child}
              </button>
            );
          }
          if (isActionChild(child)) {
            const label = child.label || child.action || "action";
            const id = child.node_id;
            return (
              <button
                key={`${label}-${index}`}
                type="button"
                className="history-chip"
                disabled={!id}
                onClick={() => {
                  if (id) {
                    void followAction(id);
                  }
                }}
              >
                {label}
                {child.frequency != null ? ` ${(child.frequency * 100).toFixed(0)}%` : ""}
              </button>
            );
          }
          const card = child.card || "?";
          const id = child.node_id;
          return (
            <button
              key={`${card}-${index}`}
              type="button"
              className="history-chip"
              disabled={!id}
              onClick={() => {
                if (id) {
                  void followAction(id);
                }
              }}
            >
              {card}
            </button>
          );
        })}
      </div>
      <div
        className="resize-handle"
        onPointerDown={onPointerDown}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize action history"
      />
    </section>
  );
}
