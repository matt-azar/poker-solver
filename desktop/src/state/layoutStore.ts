import { create } from "zustand";

// v3: drop stale v2 heights/widths that left empty gutters after Cursor-minimal
// (#489 moved Hands out of matrix-stage; fixed path-nav height became a band).
const LAYOUT_KEY = "study-layout-v3";

export interface StudyLayout {
  lowerDock: boolean;
  dualRange: boolean;
  inspectorWidth: number;
  historyHeight: number;
  lowerDockHeight: number;
  /** Dual-range only: user-dragged width of a matrix wrap. Null = auto square. */
  matrixWidth: number | null;
  density: "comfortable" | "compact";
}

export const DEFAULT_LAYOUT: StudyLayout = {
  // Closed until the player opens an analysis tab, so the matrix owns the page.
  lowerDock: false,
  dualRange: false,
  // Permanent right rail targets ~40% width; CSS grid owns the split.
  inspectorWidth: 420,
  // Max cap for content-sized path-nav (not a forced empty height).
  historyHeight: 72,
  lowerDockHeight: 200,
  matrixWidth: null,
  density: "comfortable",
};

const DOCK_MIN = 120;
const HISTORY_MIN = 40;

function dockMaxPx(): number {
  if (typeof window === "undefined") {
    return 1200;
  }
  // The open dock overlays the chart, so it may cover most of the study page.
  return Math.max(DOCK_MIN, window.innerHeight - 96);
}

function historyMaxPx(): number {
  if (typeof window === "undefined") {
    return 120;
  }
  // Cursor-minimal green strip stays short; never reserve 35% of the window.
  return Math.min(120, Math.max(72, Math.floor(window.innerHeight * 0.14)));
}

export function clampDockHeight(height: number): number {
  return Math.min(dockMaxPx(), Math.max(DOCK_MIN, Math.round(height)));
}

export function clampHistoryHeight(height: number): number {
  return Math.min(historyMaxPx(), Math.max(HISTORY_MIN, Math.round(height)));
}

/** Pixel width for a user-resized range matrix. Null or non-positive means auto. */
export function clampMatrixWidth(value: unknown): number | null {
  if (value == null || value === "") {
    return null;
  }
  const width = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(width) || width <= 0) {
    return null;
  }
  return Math.min(1600, Math.max(180, Math.round(width)));
}

function sanitizeLayout(raw: Partial<StudyLayout> & { leftNav?: unknown }): StudyLayout {
  const { leftNav: _removed, ...rest } = raw;
  const merged = { ...DEFAULT_LAYOUT, ...rest };
  return {
    lowerDock: merged.lowerDock !== false,
    dualRange: Boolean(merged.dualRange),
    lowerDockHeight: clampDockHeight(
      Number(merged.lowerDockHeight) || DEFAULT_LAYOUT.lowerDockHeight,
    ),
    historyHeight: clampHistoryHeight(
      Number(merged.historyHeight) || DEFAULT_LAYOUT.historyHeight,
    ),
    inspectorWidth: Math.min(
      720,
      Math.max(280, Number(merged.inspectorWidth) || DEFAULT_LAYOUT.inspectorWidth),
    ),
    matrixWidth: clampMatrixWidth(merged.matrixWidth),
    density: merged.density === "compact" ? "compact" : "comfortable",
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
    if ("matrixWidth" in next) {
      next.matrixWidth = clampMatrixWidth(next.matrixWidth);
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
