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
  handIndexForCombo,
  isHandLocked,
  lockForNode,
  normalizeProbs,
  seedProbsFromStrategy,
  toggleHandIndex,
  type ComparePayload,
  type LockDraft,
  type LockRecord,
  type LocksPayload,
} from "../domain/locks";
import type {
  StrategyEditDraft,
  StrategyEditRecord,
  StrategyEditsPayload,
} from "../domain/strategyEdits";
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

export interface LibraryRecentEntry {
  path: string;
  name: string;
  mtime: number;
}

export interface LibraryNamedEntry {
  id: string;
  name: string;
  folder?: string;
}

export interface LibraryLists {
  recent: LibraryRecentEntry[];
  templates: LibraryNamedEntry[];
  ranges: LibraryNamedEntry[];
  loading: boolean;
}

interface SelectedCell {
  row: number;
  col: number;
  text: string;
}

function joinSizes(values: unknown): string {
  if (!Array.isArray(values)) {
    return "";
  }
  return values.map((value) => String(value)).join(", ");
}

function asNamedList(data: unknown): LibraryNamedEntry[] {
  if (!Array.isArray(data)) {
    return [];
  }
  const out: LibraryNamedEntry[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const id = String((entry as { id?: unknown }).id ?? "").trim();
    if (!id) {
      continue;
    }
    const name = String((entry as { name?: unknown }).name ?? id).trim() || id;
    const folderRaw = (entry as { folder?: unknown }).folder;
    const folder =
      folderRaw == null || folderRaw === undefined
        ? undefined
        : String(folderRaw).trim();
    out.push(folder ? { id, name, folder } : { id, name });
  }
  return out;
}

function asRecentList(data: unknown): LibraryRecentEntry[] {
  if (!Array.isArray(data)) {
    return [];
  }
  const out: LibraryRecentEntry[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const path = String((entry as { path?: unknown }).path ?? "").trim();
    if (!path) {
      continue;
    }
    const name = String((entry as { name?: unknown }).name ?? path).trim() || path;
    const mtimeRaw = (entry as { mtime?: unknown }).mtime;
    const mtime = typeof mtimeRaw === "number" ? mtimeRaw : Number(mtimeRaw) || 0;
    out.push({ path, name, mtime });
  }
  return out;
}

/** Map POST /api/config JSON onto SpotDraft fields (mirrors legacy ui applyConfigText). */
function draftFromParsedConfig(body: Record<string, unknown>): Partial<SpotDraft> {
  const board = Array.isArray(body.board)
    ? body.board.map((card) => String(card)).join(" ")
    : "";
  const partial: Partial<SpotDraft> = {
    boardText: board,
    pot: Number(body.pot) || 0,
    stack: Number(body.stack) || 0,
    maxRaises: Number(body.max_raises) || 0,
    allowAllIn: Boolean(body.allow_all_in),
    oopBets: joinSizes(body.oop_bets),
    ipBets: joinSizes(body.ip_bets),
  };
  if (body.kind === "street") {
    partial.oopFlop = joinSizes(body.oop_flop_bets);
    partial.ipFlop = joinSizes(body.ip_flop_bets);
    partial.oopTurn = joinSizes(body.oop_turn_bets);
    partial.ipTurn = joinSizes(body.ip_turn_bets);
    partial.oopRiver = joinSizes(body.oop_river_bets);
    partial.ipRiver = joinSizes(body.ip_river_bets);
    partial.oopDonk = joinSizes(body.oop_donk);
    partial.potCap = Number(body.pot_cap) || 0;
    partial.noThreeBet = body.allow_three_bet === false;
    partial.geometric = Boolean(body.geometric);
    partial.allInThreshold = Number(body.all_in_threshold) || 0;
    partial.memoryMib = Number(body.memory_mib) || 0;
    partial.threads = Number(body.threads) || 1;
    if (Array.isArray(body.tree_edits)) {
      partial.treeEdits = body.tree_edits.map((line) => String(line)).filter(Boolean);
    }
  }
  return partial;
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

function rootNodeId(statusRoot?: string | null): string {
  return statusRoot || "p0.t-1.r-1";
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
    incentives: parseIncentiveRules(draft.incentives),
    edge_tags: parseEdgeTagSpecs(draft.edgeTags),
  };
  if (draft.timeLimit.trim() !== "") {
    body.time_limit = Number(draft.timeLimit);
  }
  if (draft.treeEdits.length > 0) {
    body.tree_edits = [...draft.treeEdits];
  }
  return body;
}

function parseIncentiveRules(text: string): SolveJobRequest["incentives"] {
  return String(text || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((line) => {
      const tokens = line.split(/[\s,]+/).filter(Boolean);
      if (tokens.length !== 4) {
        throw new Error("incentive needs kind player key delta");
      }
      const kind = tokens[0];
      if (kind !== "label" && kind !== "tag") {
        throw new Error("incentive kind must be label or tag");
      }
      return {
        kind,
        player: Number(tokens[1]),
        key: tokens[2],
        delta: Number(tokens[3]),
      };
    });
}

function parseEdgeTagSpecs(text: string): SolveJobRequest["edge_tags"] {
  return String(text || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((line) => {
      const tokens = line.split(/[\s,]+/).filter(Boolean);
      if (tokens.length < 2) {
        throw new Error("edge-tag needs ACTION TAG");
      }
      let player = -1;
      let actionAt = 0;
      if ((tokens[0] === "0" || tokens[0] === "1") && tokens.length >= 3) {
        player = Number(tokens[0]);
        actionAt = 1;
      }
      return {
        player,
        action: tokens[actionAt],
        tags: tokens.slice(actionAt + 1),
      };
    });
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
  compareNote: ComparePayload | null;

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

  lockDrawerOpen: boolean;
  setLockDrawerOpen: (open: boolean) => void;
  locks: LockRecord[];
  lockDraft: LockDraft;
  lockDraftBaseline: LockDraft | null;
  setLockKind: (kind: LockDraft["kind"]) => void;
  setLockProbs: (probs: number[]) => void;
  setLockProbAt: (index: number, value: number) => void;
  toggleLockHand: (handIndex: number) => void;
  selectCombosForLock: (combos: string[]) => void;
  seedLockFromStrategy: () => void;
  revertLockDraft: () => void;
  refreshLocks: () => Promise<void>;
  applyLock: () => Promise<void>;
  unlockHands: (handIndices?: number[]) => Promise<void>;
  unlockNode: () => Promise<void>;
  clearAllLocks: () => Promise<void>;
  isHandLockedAtCurrentNode: (handIndex: number) => boolean;

  strategyEditDrawerOpen: boolean;
  setStrategyEditDrawerOpen: (open: boolean) => void;
  strategyEdits: StrategyEditRecord[];
  strategyEditDraft: StrategyEditDraft;
  strategyEditDraftBaseline: StrategyEditDraft | null;
  setStrategyEditKind: (kind: StrategyEditDraft["kind"]) => void;
  setStrategyEditProbAt: (index: number, value: number) => void;
  toggleStrategyEditHand: (handIndex: number) => void;
  selectCombosForStrategyEdit: (combos: string[]) => void;
  seedStrategyEditFromStrategy: () => void;
  revertStrategyEditDraft: () => void;
  refreshStrategyEdits: () => Promise<void>;
  applyStrategyEdit: () => Promise<void>;
  clearStrategyEditHands: (handIndices?: number[]) => Promise<void>;
  clearStrategyEditNode: () => Promise<void>;
  clearAllStrategyEdits: () => Promise<void>;

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
  loadCompare: (nodeId?: string) => Promise<void>;

  libraryLists: LibraryLists;
  loadRecent: () => Promise<void>;
  loadTemplates: () => Promise<void>;
  loadRanges: () => Promise<void>;
  applyTemplate: (id: string) => Promise<void>;
  applyRangePreset: (id: string, player: "oop" | "ip") => Promise<void>;
}

function defaultLockDraft(actionCount: number): LockDraft {
  return {
    kind: "selected",
    handIndices: [],
    probs: Array.from({ length: actionCount }, (_, index) =>
      actionCount === 0 ? 0 : index === 0 ? 1 : 0,
    ),
  };
}

const rangeHistory = createRangeHistory();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let nodeToken = 0;
let valueToken = 0;
let seenGeneration = -1;
let continuationPending = false;
let valuePollTimer: ReturnType<typeof setInterval> | null = null;

function clearValuePoll() {
  if (valuePollTimer) {
    clearInterval(valuePollTimer);
    valuePollTimer = null;
  }
}

/** Poll async analysis endpoints that may return `{ pending: true }` / HTTP 202. */
async function pollAnalysis<T extends { pending?: boolean }>(
  token: number,
  fetchOnce: () => Promise<T>,
  onReady: (body: T) => void,
  onError: (message: string) => void,
): Promise<void> {
  clearValuePoll();
  const tick = async () => {
    try {
      const body = await fetchOnce();
      if (token !== valueToken) {
        return;
      }
      if (body && body.pending) {
        if (!valuePollTimer) {
          valuePollTimer = setInterval(() => {
            void tick();
          }, 250);
        }
        return;
      }
      clearValuePoll();
      onReady(body);
    } catch (error) {
      if (token !== valueToken) {
        return;
      }
      clearValuePoll();
      onError(error instanceof EngineError ? error.message : "Analysis request failed");
    }
  };
  await tick();
}

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
  message: "Connecting to local engine…",
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

  lockDrawerOpen: false,
  setLockDrawerOpen(open) {
    if (!open) {
      set({ lockDrawerOpen: false });
      return;
    }
    const actions = get().currentNode?.actions?.length ?? 0;
    const existing = get().lockDraft;
    const draft =
      existing.probs.length === actions
        ? existing
        : defaultLockDraft(actions);
    set({
      lockDrawerOpen: true,
      strategyEditDrawerOpen: false,
      lockDraft: draft,
      lockDraftBaseline: structuredClone(draft),
    });
    void get().refreshLocks();
  },
  locks: [],
  lockDraft: defaultLockDraft(0),
  lockDraftBaseline: null,
  setLockKind(kind) {
    set({ lockDraft: { ...get().lockDraft, kind } });
  },
  setLockProbs(probs) {
    set({ lockDraft: { ...get().lockDraft, probs: probs.slice() } });
  },
  setLockProbAt(index, value) {
    const probs = get().lockDraft.probs.slice();
    probs[index] = value;
    set({ lockDraft: { ...get().lockDraft, probs } });
  },
  toggleLockHand(handIndex) {
    const handIndices = toggleHandIndex(get().lockDraft.handIndices, handIndex);
    set({ lockDraft: { ...get().lockDraft, handIndices, kind: "selected" } });
  },
  selectCombosForLock(combos) {
    const node = get().currentNode;
    if (!node?.combos) {
      return;
    }
    const handIndices = combos
      .map((combo) => handIndexForCombo(node.combos, combo))
      .filter((index) => index >= 0);
    const unique = [...new Set(handIndices)].sort((a, b) => a - b);
    const actions = node.actions?.length ?? 0;
    const probs = seedProbsFromStrategy(node.strategy ?? null, unique, actions);
    const draft: LockDraft = { kind: "selected", handIndices: unique, probs };
    set({
      lockDraft: draft,
      lockDraftBaseline: structuredClone(draft),
      lockDrawerOpen: true,
      strategyEditDrawerOpen: false,
    });
    void get().refreshLocks();
  },
  seedLockFromStrategy() {
    const node = get().currentNode;
    const actions = node?.actions?.length ?? 0;
    const probs = seedProbsFromStrategy(
      node?.strategy ?? null,
      get().lockDraft.handIndices,
      actions,
    );
    set({ lockDraft: { ...get().lockDraft, probs } });
  },
  revertLockDraft() {
    const baseline = get().lockDraftBaseline;
    if (!baseline) {
      return;
    }
    set({ lockDraft: structuredClone(baseline) });
  },
  async refreshLocks() {
    const solutionId = get().solutionId;
    if (!solutionId) {
      set({ locks: [] });
      return;
    }
    try {
      const payload = (await engineClient.listLocks(solutionId)) as LocksPayload;
      set({ locks: payload.locks || [] });
    } catch (error) {
      set({
        message: error instanceof EngineError ? error.message : "Failed to list locks",
      });
    }
  },
  isHandLockedAtCurrentNode(handIndex) {
    const node = get().currentNode;
    if (!node) {
      return false;
    }
    return isHandLocked(lockForNode(get().locks, node.node_id), handIndex);
  },
  async applyLock() {
    const solutionId = get().solutionId;
    const node = get().currentNode;
    if (!solutionId || !node || node.kind !== "decision") {
      set({ message: "Locks require a published decision node." });
      return;
    }
    const draft = get().lockDraft;
    if (draft.kind === "selected" && draft.handIndices.length === 0) {
      set({ message: "Select at least one combo, or switch to full-node lock." });
      return;
    }
    const normalized = normalizeProbs(draft.probs);
    if (!normalized.valid) {
      set({
        message: normalized.reason || "Lock probabilities are invalid.",
      });
      return;
    }
    try {
      const body =
        draft.kind === "full"
          ? {
              node_id: node.node_id,
              kind: "full" as const,
              probs: normalized.probs,
            }
          : {
              node_id: node.node_id,
              kind: "selected" as const,
              hand_indices: draft.handIndices,
              probs: normalized.probs,
            };
      const payload = (await engineClient.putLock(solutionId, body)) as LocksPayload;
      set({
        locks: payload.locks || [],
        lockDraft: { ...draft, probs: normalized.probs },
        lockDraftBaseline: structuredClone({ ...draft, probs: normalized.probs }),
        message:
          draft.kind === "full"
            ? `Full-node lock applied at ${node.node_id}`
            : `Locked ${draft.handIndices.length} combo(s) at ${node.node_id}`,
      });
    } catch (error) {
      set({
        message: error instanceof EngineError ? error.message : "Lock failed",
      });
    }
  },
  async unlockHands(handIndices) {
    const solutionId = get().solutionId;
    const node = get().currentNode;
    if (!solutionId || !node) {
      return;
    }
    const targets = handIndices ?? get().lockDraft.handIndices;
    if (!targets.length) {
      set({ message: "No combo selected to unlock." });
      return;
    }
    try {
      for (const handIndex of targets) {
        await engineClient.deleteLock(solutionId, node.node_id, handIndex);
      }
      await get().refreshLocks();
      set({ message: `Unlocked ${targets.length} combo(s) at ${node.node_id}` });
    } catch (error) {
      set({
        message: error instanceof EngineError ? error.message : "Unlock failed",
      });
    }
  },
  async unlockNode() {
    const solutionId = get().solutionId;
    const node = get().currentNode;
    if (!solutionId || !node) {
      return;
    }
    try {
      await engineClient.deleteLock(solutionId, node.node_id);
      await get().refreshLocks();
      set({ message: `Cleared locks at ${node.node_id}` });
    } catch (error) {
      set({
        message: error instanceof EngineError ? error.message : "Unlock node failed",
      });
    }
  },
  async clearAllLocks() {
    const solutionId = get().solutionId;
    if (!solutionId) {
      return;
    }
    try {
      await engineClient.deleteLock(solutionId);
      await get().refreshLocks();
      set({ message: "Cleared all locks on this solution." });
    } catch (error) {
      set({
        message: error instanceof EngineError ? error.message : "Clear locks failed",
      });
    }
  },

  strategyEditDrawerOpen: false,
  setStrategyEditDrawerOpen(open) {
    if (!open) {
      set({ strategyEditDrawerOpen: false });
      return;
    }
    const actions = get().currentNode?.actions?.length ?? 0;
    const existing = get().strategyEditDraft;
    const draft =
      existing.probs.length === actions ? existing : defaultLockDraft(actions);
    set({
      strategyEditDrawerOpen: true,
      lockDrawerOpen: false,
      strategyEditDraft: draft,
      strategyEditDraftBaseline: structuredClone(draft),
    });
    void get().refreshStrategyEdits();
  },
  strategyEdits: [],
  strategyEditDraft: defaultLockDraft(0),
  strategyEditDraftBaseline: null,
  setStrategyEditKind(kind) {
    set({ strategyEditDraft: { ...get().strategyEditDraft, kind } });
  },
  setStrategyEditProbAt(index, value) {
    const probs = get().strategyEditDraft.probs.slice();
    probs[index] = value;
    set({ strategyEditDraft: { ...get().strategyEditDraft, probs } });
  },
  toggleStrategyEditHand(handIndex) {
    const handIndices = toggleHandIndex(get().strategyEditDraft.handIndices, handIndex);
    set({
      strategyEditDraft: { ...get().strategyEditDraft, handIndices, kind: "selected" },
    });
  },
  selectCombosForStrategyEdit(combos) {
    const node = get().currentNode;
    if (!node?.combos) {
      return;
    }
    const handIndices = combos
      .map((combo) => handIndexForCombo(node.combos, combo))
      .filter((index) => index >= 0);
    const unique = [...new Set(handIndices)].sort((a, b) => a - b);
    const actions = node.actions?.length ?? 0;
    const probs = seedProbsFromStrategy(node.strategy ?? null, unique, actions);
    const draft: StrategyEditDraft = { kind: "selected", handIndices: unique, probs };
    set({
      strategyEditDraft: draft,
      strategyEditDraftBaseline: structuredClone(draft),
      strategyEditDrawerOpen: true,
      lockDrawerOpen: false,
    });
    void get().refreshStrategyEdits();
  },
  seedStrategyEditFromStrategy() {
    const node = get().currentNode;
    const actions = node?.actions?.length ?? 0;
    const probs = seedProbsFromStrategy(
      node?.strategy ?? null,
      get().strategyEditDraft.handIndices,
      actions,
    );
    set({ strategyEditDraft: { ...get().strategyEditDraft, probs } });
  },
  revertStrategyEditDraft() {
    const baseline = get().strategyEditDraftBaseline;
    if (!baseline) {
      return;
    }
    set({ strategyEditDraft: structuredClone(baseline) });
  },
  async refreshStrategyEdits() {
    const solutionId = get().solutionId;
    if (!solutionId) {
      set({ strategyEdits: [] });
      return;
    }
    try {
      const payload = (await engineClient.listStrategyEdits(solutionId)) as StrategyEditsPayload;
      set({ strategyEdits: payload.edits || [] });
    } catch (error) {
      set({
        message:
          error instanceof EngineError ? error.message : "Failed to list strategy edits",
      });
    }
  },
  async applyStrategyEdit() {
    const solutionId = get().solutionId;
    const node = get().currentNode;
    if (!solutionId || !node || node.kind !== "decision") {
      set({ message: "Strategy edits require a published decision node." });
      return;
    }
    const draft = get().strategyEditDraft;
    if (draft.kind === "selected" && draft.handIndices.length === 0) {
      set({ message: "Select at least one combo, or switch to full-node edit." });
      return;
    }
    const normalized = normalizeProbs(draft.probs);
    if (!normalized.valid) {
      set({ message: normalized.reason || "Strategy probabilities are invalid." });
      return;
    }
    try {
      const body =
        draft.kind === "full"
          ? {
              node_id: node.node_id,
              kind: "full" as const,
              probs: normalized.probs,
            }
          : {
              node_id: node.node_id,
              kind: "selected" as const,
              hand_indices: draft.handIndices,
              probs: normalized.probs,
            };
      const payload = (await engineClient.putStrategyEdit(
        solutionId,
        body,
      )) as StrategyEditsPayload;
      set({
        strategyEdits: payload.edits || [],
        strategyEditDraft: { ...draft, probs: normalized.probs },
        strategyEditDraftBaseline: structuredClone({ ...draft, probs: normalized.probs }),
        message:
          draft.kind === "full"
            ? `Full-node strategy edit applied at ${node.node_id}`
            : `Edited ${draft.handIndices.length} combo(s) at ${node.node_id}`,
      });
      await get().navigateTo(node.node_id);
    } catch (error) {
      set({
        message: error instanceof EngineError ? error.message : "Strategy edit failed",
      });
    }
  },
  async clearStrategyEditHands(handIndices) {
    const solutionId = get().solutionId;
    const node = get().currentNode;
    if (!solutionId || !node) {
      return;
    }
    const targets = handIndices ?? get().strategyEditDraft.handIndices;
    if (!targets.length) {
      set({ message: "No combo selected to clear." });
      return;
    }
    try {
      for (const handIndex of targets) {
        await engineClient.deleteStrategyEdit(solutionId, node.node_id, handIndex);
      }
      await get().refreshStrategyEdits();
      await get().navigateTo(node.node_id);
      set({ message: `Cleared ${targets.length} strategy edit(s) at ${node.node_id}` });
    } catch (error) {
      set({
        message: error instanceof EngineError ? error.message : "Clear strategy edit failed",
      });
    }
  },
  async clearStrategyEditNode() {
    const solutionId = get().solutionId;
    const node = get().currentNode;
    if (!solutionId || !node) {
      return;
    }
    try {
      await engineClient.deleteStrategyEdit(solutionId, node.node_id);
      await get().refreshStrategyEdits();
      await get().navigateTo(node.node_id);
      set({ message: `Cleared strategy edits at ${node.node_id}` });
    } catch (error) {
      set({
        message: error instanceof EngineError ? error.message : "Clear node strategy edits failed",
      });
    }
  },
  async clearAllStrategyEdits() {
    const solutionId = get().solutionId;
    if (!solutionId) {
      return;
    }
    try {
      await engineClient.deleteStrategyEdit(solutionId);
      await get().refreshStrategyEdits();
      const nodeId = get().currentNode?.node_id;
      if (nodeId) {
        await get().navigateTo(nodeId);
      }
      set({ message: "Cleared all strategy edits on this solution." });
    } catch (error) {
      set({
        message: error instanceof EngineError ? error.message : "Clear strategy edits failed",
      });
    }
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
    clearValuePoll();
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
        await get().navigateTo(
          get().currentNode?.node_id || rootNodeId(status.root_node_id),
        );
      } else if (status.running) {
        set({
          message: status.paused
            ? "Pause requested — finishing current sample…"
            : `Solving… ${status.iterations ?? 0} iterations`,
        });
      }
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "Engine unreachable";
      set({
        connection: "disconnected",
        message: `Engine unreachable: ${detail}. Use Reconnect — the installer should have placed holdem-explorer beside the app.`,
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
        lockDraft: defaultLockDraft(node.actions?.length ?? 0),
        lockDraftBaseline: defaultLockDraft(node.actions?.length ?? 0),
      });
      void get().refreshLocks();
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
    await pollAnalysis(
      token,
      () => engineClient.getValues(solutionId, node.node_id),
      (values) => {
        set({
          nodeValues: values,
          phase: phaseFromStatus(get().status, "complete"),
          message: "Action EVs ready.",
          matrixMode: get().matrixMode === "strategy" ? "strategy-ev" : get().matrixMode,
        });
      },
      (message) => {
        set({
          phase: phaseFromStatus(get().status, "complete"),
          message,
        });
      },
    );
  },

  async loadRunouts() {
    const solutionId = get().solutionId;
    const node = get().currentNode;
    if (!solutionId || !node) {
      return;
    }
    const token = ++valueToken;
    set({
      message: "Loading runouts…",
      analysisTab: "runouts",
      runouts: { pending: true },
    });
    await pollAnalysis(
      token,
      () =>
        engineClient.getRunouts(solutionId, node.node_id) as Promise<{ pending?: boolean }>,
      (runouts) => {
        set({ runouts, message: "Runouts ready." });
      },
      (message) => set({ message, runouts: null }),
    );
  },

  async loadEquity() {
    const solutionId = get().solutionId;
    const node = get().currentNode;
    if (!solutionId || !node) {
      return;
    }
    const token = ++valueToken;
    set({
      message: "Loading equity…",
      analysisTab: "equity",
      equity: { pending: true },
    });
    await pollAnalysis(
      token,
      () =>
        engineClient.getEquity(solutionId, node.node_id) as Promise<{ pending?: boolean }>,
      (equity) => {
        set({ equity, message: "Equity ready." });
      },
      (message) => set({ message }),
    );
  },

  async loadCategories() {
    const solutionId = get().solutionId;
    const node = get().currentNode;
    if (!solutionId || !node) {
      return;
    }
    const token = ++valueToken;
    set({
      message: "Loading categories…",
      analysisTab: "categories",
      categories: { pending: true },
    });
    await pollAnalysis(
      token,
      () =>
        engineClient.getCategories(solutionId, node.node_id) as Promise<{ pending?: boolean }>,
      (categories) => {
        set({ categories, message: "Categories ready." });
      },
      (message) => set({ message }),
    );
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

  async loadCompare(nodeId) {
    const baseline = get().baselineSolutionId;
    const scenario = get().solutionId;
    const targetNode = nodeId || get().currentNode?.node_id;
    if (!baseline || !scenario || !targetNode) {
      set({
        message:
          "Compare needs a baseline (after resolve-locked), the scenario solution, and a decision node.",
      });
      return;
    }
    try {
      const compareNote = (await engineClient.compare(
        baseline,
        scenario,
        targetNode,
      )) as ComparePayload;
      set({
        compareNote,
        workspace: "compare",
        message: `Compare ${baseline} → ${scenario}: EV Δ ${Number(compareNote.value_delta).toFixed(4)}`,
      });
    } catch (error) {
      set({
        compareNote: null,
        message: error instanceof EngineError ? error.message : "Compare failed",
      });
    }
  },

  libraryLists: {
    recent: [],
    templates: [],
    ranges: [],
    loading: false,
  },

  async loadRecent() {
    set({
      libraryLists: { ...get().libraryLists, loading: true },
    });
    try {
      const data = await engineClient.recentSolutions();
      set({
        libraryLists: {
          ...get().libraryLists,
          recent: asRecentList(data),
          loading: false,
        },
        connection: "connected",
      });
    } catch (error) {
      set({
        libraryLists: { ...get().libraryLists, recent: [], loading: false },
        connection: "disconnected",
        message:
          error instanceof EngineError
            ? error.message
            : error instanceof Error
              ? `Engine unreachable: ${error.message}`
              : "Failed to load recent solutions",
      });
    }
  },

  async loadTemplates() {
    set({
      libraryLists: { ...get().libraryLists, loading: true },
    });
    try {
      const data = await engineClient.templates();
      set({
        libraryLists: {
          ...get().libraryLists,
          templates: asNamedList(data),
          loading: false,
        },
        connection: "connected",
      });
    } catch (error) {
      set({
        libraryLists: { ...get().libraryLists, templates: [], loading: false },
        connection: "disconnected",
        message:
          error instanceof EngineError
            ? error.message
            : error instanceof Error
              ? `Engine unreachable: ${error.message}`
              : "Failed to load templates",
      });
    }
  },

  async loadRanges() {
    set({
      libraryLists: { ...get().libraryLists, loading: true },
    });
    try {
      const data = await engineClient.ranges();
      set({
        libraryLists: {
          ...get().libraryLists,
          ranges: asNamedList(data),
          loading: false,
        },
        connection: "connected",
      });
    } catch (error) {
      set({
        libraryLists: { ...get().libraryLists, ranges: [], loading: false },
        connection: "disconnected",
        message:
          error instanceof EngineError
            ? error.message
            : error instanceof Error
              ? `Engine unreachable: ${error.message}`
              : "Failed to load range presets",
      });
    }
  },

  async applyTemplate(id) {
    const trimmed = id.trim();
    if (!trimmed) {
      set({ message: "Choose a template first." });
      return;
    }
    set({ message: `Loading template ${trimmed}…` });
    try {
      const template = await engineClient.template(trimmed);
      const parsed = await engineClient.parseConfig(template.text);
      const partial = draftFromParsedConfig(parsed);
      get().updateDraft(partial);
      const oop = typeof parsed.oop_range === "string" ? parsed.oop_range : "";
      const ip = typeof parsed.ip_range === "string" ? parsed.ip_range : "";
      get().setRangeText("oop", oop);
      get().setRangeText("ip", ip);
      const kind = typeof parsed.kind === "string" ? parsed.kind : "configuration";
      set({
        message: `Loaded template ${trimmed} (${kind}) into Build draft.`,
        workspace: "build",
      });
    } catch (error) {
      set({
        message: error instanceof EngineError ? error.message : "Template failed",
      });
    }
  },

  async applyRangePreset(id, player) {
    const trimmed = id.trim();
    if (!trimmed) {
      set({ message: "Choose a range preset first." });
      return;
    }
    set({ message: `Loading range ${trimmed}…` });
    try {
      const preset = await engineClient.rangePreset(trimmed);
      const text = typeof preset.text === "string" ? preset.text.trim() : "";
      get().setRangeText(player, text);
      set({
        message: `Loaded range ${trimmed} into ${player.toUpperCase()}.`,
      });
    } catch (error) {
      set({
        message: error instanceof EngineError ? error.message : "Range preset failed",
      });
    }
  },
}));
