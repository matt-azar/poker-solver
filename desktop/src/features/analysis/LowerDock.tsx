import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { clampDockHeight } from "../../state/layoutStore";
import { useStudyStore } from "../../state/studyStore";
import { AnalysisDockPanel } from "./AnalysisDockPanel";
import { LineCardReport } from "./LineCardReport";
import { ValueBluffsPanel } from "./ValueBluffsPanel";
import { RunoutTable } from "./RunoutTable";

const TABS = [
  { id: "runouts", label: "Runouts" },
  { id: "line-cards", label: "Compare cards" },
  { id: "equity", label: "Equity" },
  { id: "categories", label: "Categories" },
  { id: "value-bluffs", label: "Value / Bluffs" },
] as const;

type DockTabId = (typeof TABS)[number]["id"];

export function LowerDock() {
  const layout = useStudyStore((s) => s.layout);
  const setLayout = useStudyStore((s) => s.setLayout);
  const analysisTab = useStudyStore((s) => s.analysisTab);
  const setAnalysisTab = useStudyStore((s) => s.setAnalysisTab);
  const dragRef = useRef<{ startY: number; startH: number; cap: number } | null>(null);

  useEffect(() => {
    // Repair a corrupted height without forcing the dock open over the matrix.
    const repaired = clampDockHeight(layout.lowerDockHeight);
    if (repaired !== layout.lowerDockHeight) {
      setLayout({ lowerDockHeight: repaired });
    }
  }, [layout.lowerDockHeight, setLayout]);

  // Migrate removed / renamed dock tabs without editing studyStore.
  useEffect(() => {
    if (analysisTab === "explorer") {
      setAnalysisTab("equity");
      return;
    }
    if ((analysisTab as string) === "bluffs") {
      setAnalysisTab("value-bluffs");
    }
  }, [analysisTab, setAnalysisTab]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const workspace = event.currentTarget.closest(".study-workspace");
      const cap = workspace
        ? Math.max(160, workspace.clientHeight - 96)
        : Number.POSITIVE_INFINITY;
      dragRef.current = { startY: event.clientY, startH: layout.lowerDockHeight, cap };
      const onMove = (ev: PointerEvent) => {
        if (!dragRef.current) {
          return;
        }
        const next = Math.min(
          dragRef.current.cap,
          clampDockHeight(
            dragRef.current.startH - (ev.clientY - dragRef.current.startY),
          ),
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

  const openTab = (id: DockTabId) => {
    setAnalysisTab(id);
    setLayout({
      lowerDock: true,
      lowerDockHeight: Math.max(layout.lowerDockHeight, 400),
    });
  };

  const activeTab: DockTabId =
    analysisTab === "runouts" ||
    analysisTab === "line-cards" ||
    analysisTab === "equity" ||
    analysisTab === "categories" ||
    analysisTab === "value-bluffs"
      ? analysisTab
      : "equity";

  if (!layout.lowerDock) {
    return (
      <section className="lower-dock lower-dock--collapsed" aria-label="Analysis">
        <div className="lower-dock__tabs" role="tablist" aria-label="Analysis">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={false}
              className="dock-tab"
              onClick={() => openTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </section>
    );
  }

  let body: ReactNode;
  if (activeTab === "runouts") {
    body = <RunoutTable />;
  } else if (activeTab === "line-cards") {
    body = <LineCardReport />;
  } else if (activeTab === "value-bluffs") {
    body = <ValueBluffsPanel />;
  } else {
    body = <AnalysisDockPanel />;
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
            aria-selected={activeTab === tab.id}
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
