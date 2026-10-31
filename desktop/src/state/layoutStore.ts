import { create } from "zustand";

const LAYOUT_KEY = "study-layout-v1";

export interface StudyLayout {
  leftNav: boolean;
  lowerDock: boolean;
  inspectorWidth: number;
  historyHeight: number;
  lowerDockHeight: number;
  density: "comfortable" | "compact";
}

export const DEFAULT_LAYOUT: StudyLayout = {
  leftNav: true,
  lowerDock: true,
  inspectorWidth: 320,
  historyHeight: 120,
  lowerDockHeight: 220,
  density: "comfortable",
};

function loadLayout(): StudyLayout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) {
      return { ...DEFAULT_LAYOUT };
    }
    return { ...DEFAULT_LAYOUT, ...JSON.parse(raw) };
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
    const layout = { ...get().layout, ...partial };
    saveLayout(layout);
    set({ layout });
  },
  resetLayout() {
    const layout = { ...DEFAULT_LAYOUT };
    saveLayout(layout);
    set({ layout });
  },
}));
