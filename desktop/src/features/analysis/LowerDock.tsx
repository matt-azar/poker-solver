import { useCallback, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useStudyStore } from "../../state/studyStore";
import { RangeExplorerPanel } from "./RangeExplorerPanel";
import { RunoutTable } from "./RunoutTable";

const TABS = [
  { id: "explorer", label: "Range Explorer" },
  { id: "runouts", label: "Runouts" },
  { id: "equity", label: "Equity" },
  { id: "categories", label: "Categories" },
] as const;

const DOCK_MIN = 120;
/** Allow nearly full-viewport docks so matrix / equity charts are never trapped. */
const DOCK_MAX_VH = 0.72;

function dockMaxPx(): number {
  if (typeof window === "undefined") {
    return 720;
  }
  return Math.max(DOCK_MIN, Math.floor(window.innerHeight * DOCK_MAX_VH));
}

export function LowerDock() {
  const layout = useStudyStore((s) => s.layout);
  const setLayout = useStudyStore((s) => s.setLayout);
  const analysisTab = useStudyStore((s) => s.analysisTab);
  const setAnalysisTab = useStudyStore((s) => s.setAnalysisTab);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      event.preventDefault();
      dragRef.current = { startY: event.clientY, startH: layout.lowerDockHeight };
      const onMove = (ev: PointerEvent) => {
        if (!dragRef.current) {
          return;
        }
        const next = Math.min(
          dockMaxPx(),
          Math.max(DOCK_MIN, dragRef.current.startH - (ev.clientY - dragRef.current.startY)),
        );
        setLayout({ lowerDockHeight: next });
      };
      const onUp = () => {
        dragRef.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [layout.lowerDockHeight, setLayout],
  );

  if (!layout.lowerDock) {
    return null;
  }

  let body: ReactNode;
  if (analysisTab === "runouts") {
    body = <RunoutTable />;
  } else {
    body = <RangeExplorerPanel />;
  }

  return (
    <section
      className="lower-dock"
      style={{ height: layout.lowerDockHeight, maxHeight: dockMaxPx() }}
    >
      <div
        className="resize-handle resize-handle--top"
        onPointerDown={onPointerDown}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize analysis dock"
      />
      <div className="lower-dock__tabs" role="tablist" aria-label="Analysis">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={analysisTab === tab.id}
            className="dock-tab"
            onClick={() => setAnalysisTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="lower-dock__body">{body}</div>
    </section>
  );
}
