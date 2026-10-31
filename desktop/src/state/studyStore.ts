import { create } from "zustand";
import {
  boardCards,
  blankGrid,
  createRangeHistory,
  parseRangeText,
  parseSizeList,
  rangeText,
  snapshotWeights,
  type WeightSnapshot,
} from "../domain/range";
import {
  nextGeneration,
  shouldApply,
  solutionNeedsReload,
} from "../domain/browse";
import {
  DEFAULT_SPOT,
  type ActionValuesPayload,
  type FrequencyMode,
  type MatrixMode,
  type NodePayload,
  type SolveJobRequest,
  type SolvePhase,
  type SpotDraft,
  type StatusPayload,
} from "../domain/types";
import { EngineError, engineClient } from "../engine/client";
import { useThemeStore } from "./themeStore";
import { useLayoutStore } from "./layoutStore";

export type WorkspaceId = "study" | "build" | "compare" | "library";

interface SelectedCell {
  row: number;
  col: number;
  text: string;
}

function phaseFromStatus(status: StatusPayload | null, fallback: SolvePhase): SolvePhase {
  if (!status) {
    return fallback;
  }
  if (status.failed || status.error) {
    return "failed";
  }
  if (status.running && status.paused) {
    return "pause_requested";
  }
  if (status.running) {
    return "solving";
  }
  if (status.paused) {
    return "paused";
  }
  if (status.solution_id) {
    return "complete";
  }
  return fallback === "solving" || fallback === "pause_requested" ? "idle" : fallback;
}

function rootNodeId(): string {
  return "p00.t-1.r-1";
}

function buildJob(draft: SpotDraft): SolveJobRequest {
  const body: SolveJobRequest = {
    board: boardCards(draft.boardText),
    oop_range: draft.oopRange,
    ip_range: draft.ipRange,
    pot: draft.pot,
    stack: draft.stack,
    oop_bets: parseSizeList(draft.oopBets),
    ip_bets: parseSizeList(draft.ipBets),
    oop_flop_bets: parseSizeList(draft.oopFlop),
    ip_flop_bets: parseSizeList(draft.ipFlop),
    oop_turn_bets: parseSizeList(draft.oopTurn),
    ip_turn_bets: parseSizeList(draft.ipTurn),
    oop_river_bets: parseSizeList(draft.oopRiver),
    ip_river_bets: parseSizeList(draft.ipRiver),
    oop_donk: parseSizeList(draft.oopDonk),
    pot_cap: draft.potCap || 0,
    allow_three_bet: draft.noThreeBet ? 0 : 1,
    geometric: draft.geometric ? 1 : 0,
    all_in_threshold: draft.allInThreshold || 0,
    allow_all_in: draft.allowAllIn ? 1 : 0,
    frozen: draft.frozen ? 1 : 0,
    accuracy: draft.accuracy.trim() === "" ? -1 : Number(draft.accuracy),
    max_raises: draft.maxRaises,
    iterations: draft.iterations,
    memory_mib: draft.memoryMib,
    threads: draft.threads,
    algorithm: draft.algorithm,
    samples: Math.max(1, Math.min(20, draft.samples || 5)),
    rake_rate: draft.rakeRate || 0,
    rake_cap: draft.rakeCap || 0,
    icm_stacks: parseSizeList(draft.icmStacks),
    icm_payouts: parseSizeList(draft.icmPayouts),
  };
  if (draft.timeLimit.trim() !== "") {
    body.time_limit = Number(draft.timeLimit);
  }
  return body;
}

interface StudyState {
  workspace: WorkspaceId;
  setWorkspace: (workspace: WorkspaceId) => void;
  draft: SpotDraft;
  updateDraft: (partial: Partial<SpotDraft>) => void;
  weights: WeightSnapshot;
  setRangeText: (player: "oop" | "ip", text: string) => void;
  paintWeight: number;
  setPaintWeight: (weight: number) => void;
  paintCell: (player: "oop" | "ip", row: number, column: number, weight?: number) => void;
  clearRange: (player: "oop" | "ip") => void;
  undoRange: () => void;
  redoRange: () => void;
  canUndoRange: boolean;
  canRedoRange: boolean;

  status: StatusPayload | null;
  phase: SolvePhase;
  message: string;
  connection: "connected" | "disconnected" | "connecting";
  solutionId: string | null;
  baselineSolutionId: string | null;
  currentNode: NodePayload | null;
  nodeValues: ActionValuesPayload | null;
  runouts: unknown | null;
  equity: unknown | null;
  categories: unknown | null;
  compareNote: unknown | null;

  selectedCell: SelectedCell | null;
  hoverCell: SelectedCell | null;
  setSelectedCell: (cell: SelectedCell | null) => void;
  setHoverCell: (cell: SelectedCell | null) => void;
  frequencyMode: FrequencyMode;
  setFrequencyMode: (mode: FrequencyMode) => void;
  matrixMode: MatrixMode;
  setMatrixMode: (mode: MatrixMode) => void;
  actionFilter: number | null;
  setActionFilter: (index: number | null) => void;
  analysisTab: "explorer" | "runouts" | "equity" | "categories" | "convergence";
  setAnalysisTab: (tab: StudyState["analysisTab"]) => void;
  warmStart: boolean;
  setWarmStart: (value: boolean) => void;

  // theme/layout proxies for UI convenience
  theme: "light" | "dark";
  themePreference: string;
  setThemePreference: (value: "system" | "light" | "dark") => void;
  toggleTheme: () => void;
  layout: ReturnType<typeof useLayoutStore.getState>["layout"];
  setLayout: (partial: Partial<ReturnType<typeof useLayoutStore.getState>["layout"]>) => void;
  resetLayout: () => void;

  startPolling: () => void;
  stopPolling: () => void;
  refresh: () => Promise<void>;
  solve: () => Promise<void>;
  continueSolve: () => Promise<void>;
  resolveLocked: () => Promise<void>;
  pause: () => Promise<void>;
  stop: () => Promise<void>;
  navigateTo: (nodeId: string) => Promise<void>;
  followAction: (nodeId: string) => Promise<void>;
  calculateEv: () => Promise<void>;
  loadRunouts: () => Promise<void>;
  loadEquity: () => Promise<void>;
  loadCategories: () => Promise<void>;
  saveSolution: () => Promise<void>;
  openSolution: (path?: string) => Promise<void>;
  loadCompare: () => Promise<void>;
}

const rangeHistory = createRangeHistory();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let nodeToken = 0;
let valueToken = 0;
let seenGeneration = -1;
let continuationPending = false;
let valuePollTimer: ReturnType<typeof setInterval> | null = null;

function syncThemeProxy(set: (partial: Partial<StudyState>) => void) {
  const theme = useThemeStore.getState();
  set({
    theme: theme.theme,
    themePreference: theme.preference,
  });
}

useThemeStore.subscribe((state) => {
  useStudyStore.setState({
    theme: state.theme,
    themePreference: state.preference,
  });
});

useLayoutStore.subscribe((state) => {
  useStudyStore.setState({ layout: state.layout });
});

export const useStudyStore = create<StudyState>((set, get) => ({
  workspace: "study",
  setWorkspace(workspace) {
    set({ workspace });
  },
  draft: { ...DEFAULT_SPOT },
  updateDraft(partial) {
    set({ draft: { ...get().draft, ...partial } });
  },
  weights: {
    oop: parseRangeText(DEFAULT_SPOT.oopRange),
    ip: parseRangeText(DEFAULT_SPOT.ipRange),
  },
  setRangeText(player, text) {
    const before = snapshotWeights(get().weights);
    const grid = parseRangeText(text);
    const weights = { ...get().weights, [player]: grid };
    rangeHistory.push(before);
    set({
      weights,
      draft: {
        ...get().draft,
        [player === "oop" ? "oopRange" : "ipRange"]: text,
      },
      canUndoRange: rangeHistory.canUndo(),
      canRedoRange: rangeHistory.canRedo(),
    });
  },
  paintWeight: 1,
  setPaintWeight(weight) {
    set({ paintWeight: weight });
  },
  paintCell(player, row, column, weight) {
    const before = snapshotWeights(get().weights);
    const nextWeight = weight === undefined ? get().paintWeight : weight;
    const grid = get().weights[player].map((line) => line.slice());
    const applied = grid[row][column] === nextWeight ? 0 : nextWeight;
    grid[row][column] = applied;
    const weights = { ...get().weights, [player]: grid };
    rangeHistory.push(before);
    set({
      weights,
      draft: {
        ...get().draft,
        [player === "oop" ? "oopRange" : "ipRange"]: rangeText(grid),
      },
      canUndoRange: rangeHistory.canUndo(),
      canRedoRange: rangeHistory.canRedo(),
    });
  },
  clearRange(player) {
    const before = snapshotWeights(get().weights);
    const grid = blankGrid();
    const weights = { ...get().weights, [player]: grid };
    rangeHistory.push(before);
    set({
      weights,
      draft: {
        ...get().draft,
        [player === "oop" ? "oopRange" : "ipRange"]: "",
      },
      canUndoRange: rangeHistory.canUndo(),
      canRedoRange: rangeHistory.canRedo(),
    });
  },
  undoRange() {
    const previous = rangeHistory.undo(get().weights);
    if (!previous) {
      return;
    }
    set({
      weights: previous,
      draft: {
        ...get().draft,
        oopRange: rangeText(previous.oop),
        ipRange: rangeText(previous.ip),
      },
      canUndoRange: rangeHistory.canUndo(),
      canRedoRange: rangeHistory.canRedo(),
    });
  },
  redoRange() {
    const next = rangeHistory.redo(get().weights);
    if (!next) {
      return;
    }
    set({
      weights: next,
      draft: {
        ...get().draft,
        oopRange: rangeText(next.oop),
        ipRange: rangeText(next.ip),
      },
      canUndoRange: rangeHistory.canUndo(),
      canRedoRange: rangeHistory.canRedo(),
    });
  },
  canUndoRange: false,
  canRedoRange: false,

  status: null,
  phase: "idle",
  message: "Start the explorer engine, then Solve a spot.",
  connection: "connecting",
  solutionId: null,
  baselineSolutionId: null,
  currentNode: null,
  nodeValues: null,
  runouts: null,
  equity: null,
  categories: null,
  compareNote: null,

  selectedCell: null,
  hoverCell: null,
  setSelectedCell(cell) {
    set({ selectedCell: cell });
  },
  setHoverCell(cell) {
    set({ hoverCell: cell });
  },
  frequencyMode: "aggression",
  setFrequencyMode(mode) {
    set({ frequencyMode: mode });
  },
  matrixMode: "strategy",
  setMatrixMode(mode) {
    set({ matrixMode: mode });
  },
  actionFilter: null,
  setActionFilter(index) {
    set({ actionFilter: index });
  },
  analysisTab: "convergence",
  setAnalysisTab(tab) {
    set({ analysisTab: tab });
  },
  warmStart: false,
  setWarmStart(value) {
    set({ warmStart: value });
  },

  theme: useThemeStore.getState().theme,
  themePreference: useThemeStore.getState().preference,
  setThemePreference(value) {
    useThemeStore.getState().setPreference(value);
    syncThemeProxy(set);
  },
  toggleTheme() {
    useThemeStore.getState().toggleTheme();
    syncThemeProxy(set);
  },
  layout: useLayoutStore.getState().layout,
  setLayout(partial) {
    useLayoutStore.getState().setLayout(partial);
    set({ layout: useLayoutStore.getState().layout });
  },
  resetLayout() {
    useLayoutStore.getState().resetLayout();
    set({ layout: useLayoutStore.getState().layout });
  },

  startPolling() {
    if (pollTimer) {
      return;
    }
    pollTimer = setInterval(() => {
      void get().refresh();
    }, 250);
    void get().refresh();
  },
  stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (valuePollTimer) {
      clearInterval(valuePollTimer);
      valuePollTimer = null;
    }
  },

  async refresh() {
    try {
      const status = await engineClient.status();
      const generation = nextGeneration(status, seenGeneration);
      if (generation !== null) {
        seenGeneration = generation;
      }
      const reload = solutionNeedsReload(status, get().solutionId, continuationPending);
      set({
        status,
        connection: "connected",
        phase: phaseFromStatus(status, get().phase),
        baselineSolutionId: status.baseline_solution_id ?? get().baselineSolutionId,
      });
      if (reload && status.solution_id) {
        continuationPending = false;
        set({
          solutionId: status.solution_id,
          message: status.paused
            ? "Paused — browsing available. Continue to resume."
            : status.cancelled
              ? "Stopped — keeping completed iterations."
              : "Solve complete.",
        });
        await get().navigateTo(get().currentNode?.node_id || rootNodeId());
      } else if (status.running) {
        set({
          message: status.paused
            ? "Pause requested — finishing current sample…"
            : `Solving… ${status.iterations ?? 0} iterations`,
        });
      }
    } catch (error) {
      set({
        connection: "disconnected",
        message:
          error instanceof Error
            ? `Engine unreachable: ${error.message}`
            : "Engine unreachable",
      });
    }
  },

  async solve() {
    set({
      phase: "solving",
      message: "Solving…",
      currentNode: null,
      nodeValues: null,
      runouts: null,
      equity: null,
      categories: null,
      selectedCell: null,
    });
    try {
      await engineClient.solve(buildJob(get().draft));
      continuationPending = true;
      get().startPolling();
      await get().refresh();
    } catch (error) {
      set({
        phase: "failed",
        message: error instanceof EngineError ? error.message : "Solve failed",
      });
    }
  },

  async continueSolve() {
    const solutionId = get().solutionId;
    if (!solutionId) {
      return;
    }
    set({ phase: "solving", message: "Continuing…", currentNode: null, nodeValues: null });
    try {
      const body: { iterations: number; time_limit?: number } = {
        iterations: get().draft.iterations,
      };
      if (get().draft.timeLimit.trim() !== "") {
        body.time_limit = Number(get().draft.timeLimit);
      }
      await engineClient.continueSolve(solutionId, body);
      continuationPending = true;
      get().startPolling();
      await get().refresh();
    } catch (error) {
      set({
        phase: "failed",
        message: error instanceof EngineError ? error.message : "Continue failed",
      });
    }
  },

  async resolveLocked() {
    const solutionId = get().solutionId;
    if (!solutionId) {
      return;
    }
    set({
      phase: "solving",
      message: get().warmStart
        ? "Resolving with locks (warm-start)…"
        : "Resolving with locks (reset)…",
      currentNode: null,
      nodeValues: null,
    });
    try {
      const body: {
        iterations: number;
        warm_start: number;
        time_limit?: number;
      } = {
        iterations: get().draft.iterations,
        warm_start: get().warmStart ? 1 : 0,
      };
      if (get().draft.timeLimit.trim() !== "") {
        body.time_limit = Number(get().draft.timeLimit);
      }
      await engineClient.resolveLocked(solutionId, body);
      continuationPending = true;
      get().startPolling();
      await get().refresh();
    } catch (error) {
      set({
        phase: "failed",
        message: error instanceof EngineError ? error.message : "Resolve locked failed",
      });
    }
  },

  async pause() {
    set({ phase: "pause_requested", message: "Pausing after the current sample…" });
    try {
      await engineClient.pause();
    } catch (error) {
      set({
        message: error instanceof EngineError ? error.message : "Pause failed",
      });
    }
  },

  async stop() {
    set({ phase: "stop_requested", message: "Stopping after the current sample…" });
    try {
      await engineClient.stop();
    } catch (error) {
      set({
        message: error instanceof EngineError ? error.message : "Stop failed",
      });
    }
  },

  async navigateTo(nodeId: string) {
    const solutionId = get().solutionId || get().status?.solution_id;
    if (!solutionId) {
      return;
    }
    const token = ++nodeToken;
    set({
      solutionId,
      nodeValues: null,
      phase: get().status?.running ? get().phase : get().phase,
    });
    try {
      const node = await engineClient.getNode(solutionId, nodeId);
      if (!shouldApply(token, nodeToken, node.solution_id ?? solutionId, get().solutionId || solutionId)) {
        return;
      }
      if (typeof node.status_generation === "number" && node.status_generation < seenGeneration) {
        return;
      }
      set({
        currentNode: node,
        solutionId: node.solution_id ?? solutionId,
        frequencyMode: "aggression",
        actionFilter: null,
      });
    } catch (error) {
      if (token !== nodeToken) {
        return;
      }
      set({
        message: error instanceof EngineError ? error.message : "Node load failed",
      });
    }
  },

  async followAction(nodeId: string) {
    await get().navigateTo(nodeId);
  },

  async calculateEv() {
    const solutionId = get().solutionId;
    const node = get().currentNode;
    if (!solutionId || !node) {
      return;
    }
    const token = ++valueToken;
    set({ phase: "analysis_pending", message: "Calculating action EVs…" });
    const poll = async () => {
      try {
        const values = await engineClient.getValues(solutionId, node.node_id);
        if (token !== valueToken) {
          return;
        }
        if (values.pending) {
          if (!valuePollTimer) {
            valuePollTimer = setInterval(() => {
              void poll();
            }, 250);
          }
          return;
        }
        if (valuePollTimer) {
          clearInterval(valuePollTimer);
          valuePollTimer = null;
        }
        set({
          nodeValues: values,
          phase: phaseFromStatus(get().status, "complete"),
          message: `Action EVs ready (${values.units || "chips"}, ${values.utility_basis || "root_centered"}).`,
          matrixMode: get().matrixMode === "strategy" ? "strategy-ev" : get().matrixMode,
        });
      } catch (error) {
        if (token !== valueToken) {
          return;
        }
        if (valuePollTimer) {
          clearInterval(valuePollTimer);
          valuePollTimer = null;
        }
        set({
          phase: phaseFromStatus(get().status, "complete"),
          message: error instanceof EngineError ? error.message : "EV calculation failed",
        });
      }
    };
    await poll();
  },

  async loadRunouts() {
    const solutionId = get().solutionId;
    const node = get().currentNode;
    if (!solutionId || !node) {
      return;
    }
    set({ message: "Loading runouts…", analysisTab: "runouts" });
    try {
      const runouts = await engineClient.getRunouts(solutionId, node.node_id);
      set({ runouts, message: "Runout comparison ready." });
    } catch (error) {
      set({
        message: error instanceof EngineError ? error.message : "Runouts failed",
      });
    }
  },

  async loadEquity() {
    const solutionId = get().solutionId;
    const node = get().currentNode;
    if (!solutionId || !node) {
      return;
    }
    set({ message: "Loading check-down equity…", analysisTab: "equity" });
    try {
      const equity = await engineClient.getEquity(solutionId, node.node_id);
      set({ equity, message: "Check-down equity ready (fraction of pot)." });
    } catch (error) {
      set({
        message: error instanceof EngineError ? error.message : "Equity failed",
      });
    }
  },

  async loadCategories() {
    const solutionId = get().solutionId;
    const node = get().currentNode;
    if (!solutionId || !node) {
      return;
    }
    set({ message: "Loading made-hand categories…", analysisTab: "categories" });
    try {
      const categories = await engineClient.getCategories(solutionId, node.node_id);
      set({ categories, message: "Made-hand categories ready." });
    } catch (error) {
      set({
        message: error instanceof EngineError ? error.message : "Categories failed",
      });
    }
  },

  async saveSolution() {
    const solutionId = get().solutionId;
    const path = get().draft.solutionPath.trim();
    if (!solutionId || !path) {
      set({ message: "Set a solution path before saving." });
      return;
    }
    set({ phase: "saving", message: `Saving ${path}…` });
    try {
      await engineClient.save(solutionId, path);
      set({
        phase: phaseFromStatus(get().status, "complete"),
        message: `Saved ${path}`,
      });
    } catch (error) {
      set({
        phase: phaseFromStatus(get().status, "complete"),
        message: error instanceof EngineError ? error.message : "Save failed",
      });
    }
  },

  async openSolution(path) {
    const target = (path ?? get().draft.solutionPath).trim();
    if (!target) {
      set({ message: "Set a solution path before opening." });
      return;
    }
    set({ phase: "loading", message: `Opening ${target}…`, currentNode: null });
    try {
      await engineClient.open(target);
      continuationPending = true;
      get().startPolling();
      await get().refresh();
      set({ draft: { ...get().draft, solutionPath: target } });
    } catch (error) {
      set({
        phase: "failed",
        message: error instanceof EngineError ? error.message : "Open failed",
      });
    }
  },

  async loadCompare() {
    const baseline = get().baselineSolutionId;
    const scenario = get().solutionId;
    const nodeId = get().currentNode?.node_id;
    if (!baseline || !scenario || !nodeId) {
      set({ message: "Compare needs a baseline, scenario, and node." });
      return;
    }
    try {
      const compareNote = await engineClient.compare(baseline, scenario, nodeId);
      set({ compareNote, workspace: "compare", message: "Comparison loaded." });
    } catch (error) {
      set({
        message: error instanceof EngineError ? error.message : "Compare failed",
      });
    }
  },
}));
