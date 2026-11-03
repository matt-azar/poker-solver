import { create } from "zustand";

const HELP_CHAT_KEY = "holdem-study-help-chat-v1";

export interface HelpChatWindowLayout {
  /** When false the window is hidden but layout is kept. */
  visible: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const DEFAULT_HELP_CHAT_LAYOUT: HelpChatWindowLayout = {
  visible: false,
  x: 24,
  y: 72,
  width: 360,
  height: 420,
};

const MIN_WIDTH = 280;
const MIN_HEIGHT = 240;
const MAX_WIDTH = 720;
const MAX_HEIGHT = 800;

function clampLayout(layout: HelpChatWindowLayout): HelpChatWindowLayout {
  const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(layout.width)));
  const height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(layout.height)));
  let x = Math.round(layout.x);
  let y = Math.round(layout.y);
  if (typeof window !== "undefined") {
    const maxX = Math.max(0, window.innerWidth - 48);
    const maxY = Math.max(0, window.innerHeight - 48);
    x = Math.min(maxX, Math.max(0, x));
    y = Math.min(maxY, Math.max(0, y));
  } else {
    x = Math.max(0, x);
    y = Math.max(0, y);
  }
  return {
    visible: Boolean(layout.visible),
    x,
    y,
    width,
    height,
  };
}

function loadLayout(): HelpChatWindowLayout {
  try {
    if (typeof localStorage === "undefined") {
      return { ...DEFAULT_HELP_CHAT_LAYOUT };
    }
    const raw = localStorage.getItem(HELP_CHAT_KEY);
    if (!raw) {
      return { ...DEFAULT_HELP_CHAT_LAYOUT };
    }
    return clampLayout({ ...DEFAULT_HELP_CHAT_LAYOUT, ...JSON.parse(raw) });
  } catch {
    return { ...DEFAULT_HELP_CHAT_LAYOUT };
  }
}

function saveLayout(layout: HelpChatWindowLayout) {
  try {
    if (typeof localStorage === "undefined") {
      return;
    }
    localStorage.setItem(HELP_CHAT_KEY, JSON.stringify(layout));
  } catch {
    /* ignore */
  }
}

interface HelpChatState {
  layout: HelpChatWindowLayout;
  setVisible: (visible: boolean) => void;
  toggleVisible: () => void;
  setPosition: (x: number, y: number) => void;
  setSize: (width: number, height: number) => void;
  setLayout: (partial: Partial<HelpChatWindowLayout>) => void;
  resetLayout: () => void;
}

function commit(
  set: (partial: Partial<HelpChatState>) => void,
  next: HelpChatWindowLayout,
) {
  const layout = clampLayout(next);
  saveLayout(layout);
  set({ layout });
}

export const useHelpChatStore = create<HelpChatState>((set, get) => ({
  layout:
    typeof localStorage === "undefined"
      ? { ...DEFAULT_HELP_CHAT_LAYOUT }
      : loadLayout(),
  setVisible(visible) {
    commit(set, { ...get().layout, visible });
  },
  toggleVisible() {
    const { layout } = get();
    commit(set, { ...layout, visible: !layout.visible });
  },
  setPosition(x, y) {
    commit(set, { ...get().layout, x, y });
  },
  setSize(width, height) {
    commit(set, { ...get().layout, width, height });
  },
  setLayout(partial) {
    commit(set, { ...get().layout, ...partial });
  },
  resetLayout() {
    commit(set, { ...DEFAULT_HELP_CHAT_LAYOUT });
  },
}));

export const HELP_CHAT_MIN_WIDTH = MIN_WIDTH;
export const HELP_CHAT_MIN_HEIGHT = MIN_HEIGHT;
