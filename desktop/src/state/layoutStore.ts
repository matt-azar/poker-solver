import { create } from "zustand";

const LAYOUT_KEY = "study-layout-v1";

export interface StudyLayout {
  leftNav: boolean;
  lowerDock: boolean;
  dualRange: boolean;
  inspectorWidth: number;
  historyHeight: number;
  lowerDockHeight: number;
  density: "comfortable" | "compact";
}

export const DEFAULT_LAYOUT: StudyLayout = {
  leftNav: true,
  lowerDock: true,
  dualRange: false,
  inspectorWidth: 320,
  historyHeight: 72,
  lowerDockHeight: 240,
  density: "comfortable",
};

const DOCK_MIN = 140;
const HISTORY_MIN = 56;

function dockMaxPx(): number {
  if (typeof window === "undefined") {
    return 720;
  }
  return Math.max(DOCK_MIN, Math.floor(window.innerHeight * 0.72));
}

function historyMaxPx(): number {
  if (typeof window === "undefined") {
    return 280;
  }
  return Math.max(96, Math.floor(window.innerHeight * 0.35));
}

export function clampDockHeight(height: number): number {
  return Math.min(dockMaxPx(), Math.max(DOCK_MIN, Math.round(height)));
}

export function clampHistoryHeight(height: number): number {
  return Math.min(historyMaxPx(), Math.max(HISTORY_MIN, Math.round(height)));
}

function sanitizeLayout(raw: Partial<StudyLayout>): StudyLayout {
  const merged = { ...DEFAULT_LAYOUT, ...raw };
  return {
    ...merged,
    lowerDock: merged.lowerDock !== false,
    lowerDockHeight: clampDockHeight(
      Number(merged.lowerDockHeight) || DEFAULT_LAYOUT.lowerDockHeight,
    ),
    historyHeight: clampHistoryHeight(
      Number(merged.historyHeight) || DEFAULT_LAYOUT.historyHeight,
    ),
    inspectorWidth: Math.min(
      520,
      Math.max(220, Number(merged.inspectorWidth) || DEFAULT_LAYOUT.inspectorWidth),
    ),
  };
}

function loadLayout(): StudyLayout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) {
      return { ...DEFAULT_LAYOUT };
    }
    return sanitizeLayout(JSON.parse(raw) as Partial<StudyLayout>);
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

function saveLayout(layout: StudyLayout) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    /* ignore */
  }
}

interface LayoutState {
  layout: StudyLayout;
  setLayout: (partial: Partial<StudyLayout>) => void;
  resetLayout: () => void;
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  layout: typeof localStorage === "undefined" ? { ...DEFAULT_LAYOUT } : loadLayout(),
  setLayout(partial) {
    const next: Partial<StudyLayout> = { ...partial };
    if (next.lowerDockHeight != null) {
      next.lowerDockHeight = clampDockHeight(next.lowerDockHeight);
    }
    if (next.historyHeight != null) {
      next.historyHeight = clampHistoryHeight(next.historyHeight);
    }
    // Turning the dock back on with a tiny height restores a usable size.
    if (next.lowerDock === true && (get().layout.lowerDockHeight ?? 0) < DOCK_MIN) {
      next.lowerDockHeight = DEFAULT_LAYOUT.lowerDockHeight;
    }
    const layout = sanitizeLayout({ ...get().layout, ...next });
    saveLayout(layout);
    set({ layout });
  },
  resetLayout() {
    const layout = { ...DEFAULT_LAYOUT };
    saveLayout(layout);
    set({ layout });
  },
}));
