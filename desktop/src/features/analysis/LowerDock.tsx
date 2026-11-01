import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { clampDockHeight } from "../../state/layoutStore";
import { useStudyStore } from "../../state/studyStore";
import { RangeExplorerPanel } from "./RangeExplorerPanel";
import { RunoutTable } from "./RunoutTable";

const TABS = [
  { id: "explorer", label: "Range Explorer" },
  { id: "runouts", label: "Runouts" },
  { id: "equity", label: "Equity" },
  { id: "categories", label: "Categories" },
] as const;

export function LowerDock() {
  const layout = useStudyStore((s) => s.layout);
  const setLayout = useStudyStore((s) => s.setLayout);
  const analysisTab = useStudyStore((s) => s.analysisTab);
  const setAnalysisTab = useStudyStore((s) => s.setAnalysisTab);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  useEffect(() => {
    // Repair tiny / corrupted persisted heights so the dock is never a sliver.
    const repaired = clampDockHeight(layout.lowerDockHeight);
    if (repaired !== layout.lowerDockHeight) {
      setLayout({ lowerDockHeight: repaired, lowerDock: true });
    }
  }, [layout.lowerDockHeight, setLayout]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = { startY: event.clientY, startH: layout.lowerDockHeight };
      const onMove = (ev: PointerEvent) => {
        if (!dragRef.current) {
          return;
        }
        const next = clampDockHeight(
          dragRef.current.startH - (ev.clientY - dragRef.current.startY),
        );
        setLayout({ lowerDockHeight: next, lowerDock: true });
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
    return (
      <div className="lower-dock lower-dock--collapsed">
        <button
          type="button"
          className="toolbar-btn"
          onClick={() =>
            setLayout({
              lowerDock: true,
              lowerDockHeight: Math.max(layout.lowerDockHeight, 240),
            })
          }
        >
          Show analysis dock
        </button>
      </div>
    );
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
      style={{ height: clampDockHeight(layout.lowerDockHeight) }}
    >
      <div
        className="resize-handle resize-handle--top"
        onPointerDown={onPointerDown}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize analysis dock"
        title="Drag to resize"
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
        <button
          type="button"
          className="toolbar-btn lower-dock__hide"
          title="Hide analysis dock"
          onClick={() => setLayout({ lowerDock: false })}
        >
          Hide
        </button>
      </div>
      <div className="lower-dock__body">{body}</div>
    </section>
  );
}
