import { create } from "zustand";
import {
  isDealChanceForStreet,
  linePreservingCardTargetId,
  prepareBoardCardChange as evaluateBoardCardChange,
  resolveDealChanceIdFromTrail,
  type BoardCardChangeResult,
  type DealStreet,
} from "../domain/cards";
import {
  applyPaintAtPreservingExact,
  blankGrid,
  createExactRangeHistory,
  exactPairFromTexts,
  exactPairsEqual,
  parseRangeText,
  textsFromExactPair,
  weightsFromExact,
  weightsFromExactPair,
  type ExactPairSnapshot,
  type WeightSnapshot,
} from "../domain/range";
import {
  advancePathTrail,
  pushNavHistory,
  replaceTrailAlternative,
  rootPathStep,
  type NavHistoryEntry,
  type PathAlternative,
  type PathStep,
} from "../domain/actionHistory";
import {
  acceptStatusGeneration,
  shouldApply,
  shouldApplyStatus,
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
import { presentUserText } from "../domain/userText";
import {
  DEFAULT_SPOT,
  type ActionValuesPayload,
  type FrequencyMode,
  type MatrixMode,
  type NodePayload,
  type SolvePhase,
  type SpotDraft,
  type StatusPayload,
} from "../domain/types";
import {
  applySetupTransaction,
  bumpRevision,
  compareNoteIsValid,
  draftFromOpenedSolution,
  initialRevision,
  resolveBaselineSolutionId,
  shouldClearCompareNote,
  strategyEditScopeFromNode,
  strategyEditScopesEqual,
  undoSetupTransactionGuarded,
  validateSetupForSolve,
  type AnalysisIdentity,
  type AnalysisKind,
  type SetupDraftResult,
  type SetupStudyMeta,
  type SetupUndoEntry,
  type StrategyEditScope,
} from "../domain/setup";
import { getRangeProfileCatalogue } from "../domain/profiles";
import { EngineError, engineClient } from "../engine/client";
import { isTauriRuntime } from "../platform";
import { readEngineStatus } from "../platform/engine";
import { useThemeStore } from "./themeStore";
import { useLayoutStore } from "./layoutStore";

import {
  draftFromParsedConfig,
  phaseFromStatus,
  rootNodeId,
  buildJob,
} from "./studyDraft";

const SETUP_HISTORY_LIMIT = 30;
const setupHistoryPast: SetupUndoEntry[] = [];

/** Test helper: drop assistant setup undo stack without touching draft state. */
export function resetSetupHistoryForTests() {
  setupHistoryPast.length = 0;
}

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

/** Rebuild a Build raise field from pot fractions + facing multiples. */

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

interface StudyState {
  workspace: WorkspaceId;
  setWorkspace: (workspace: WorkspaceId) => void;
  draft: SpotDraft;
  /** Bumps when the Build draft changes; assistant proposals must match. */
  draftRevision: number;
  updateDraft: (partial: Partial<SpotDraft>) => void;
  weights: WeightSnapshot;
  setRangeText: (player: "oop" | "ip", text: string) => void;
  paintWeight: number;
  setPaintWeight: (weight: number) => void;
  paintCell: (player: "oop" | "ip", row: number, column: number, weight?: number) => void;
  /** Start a drag paint stroke; toggle weight is chosen from the first cell. */
  beginPaintStroke: (player: "oop" | "ip", row: number, column: number) => void;
  /** Paint the active stroke weight onto another cell (same player only). */
  continuePaintStroke: (player: "oop" | "ip", row: number, column: number) => void;
  /** Commit one undo entry for the stroke when anything changed. */
  endPaintStroke: () => void;
  clearRange: (player: "oop" | "ip") => void;
  undoRange: () => void;
  redoRange: () => void;
  canUndoRange: boolean;
  canRedoRange: boolean;

  /** Provenance / profile snapshot from the last applied assistant or profile setup. */
  setupMeta: SetupStudyMeta | null;
  canUndoSetup: boolean;
  /**
   * Apply a resolved SetupDraftResult as one undoable transaction through the
   * same draft + range path as manual edits. Rejects stale revisions.
   */
  applySetupDraft: (
    result: SetupDraftResult,
    options?: { force?: boolean },
  ) =>
    | { ok: true; undoEntry: SetupUndoEntry }
    | { ok: false; reason: string; message: string };
  /**
   * Guarded inverse of the last assistant/setup apply. Restores only fields
   * still matching the post-apply values; later manual edits are preserved.
   */
  undoSetupTransaction: () => {
    ok: false;
    reason: "empty";
  } | {
    ok: true;
    message: string;
    restoredKeys: string[];
    conflictKeys: string[];
  };
  clearSetupMeta: () => void;
  getSetupCatalogue: () => ReturnType<typeof getRangeProfileCatalogue>;

  status: StatusPayload | null;
  phase: SolvePhase;
  message: string;
  connection: "connected" | "disconnected" | "connecting";
  solutionId: string | null;
  baselineSolutionId: string | null;
  currentNode: NodePayload | null;
  /**
   * Client-validated betting-path trail (node ids + ownership + alternatives).
   * Preferred source for deal-chance ancestors; `parent_id` walk is the fallback.
   */
  pathTrail: PathStep[];
  /**
   * Deal-chance node whose `cards[]` feed the board CardPicker while the user
   * stays on a deeper betting line. Null when no board-card change is armed.
   */
  boardChangeChanceNode: NodePayload | null;
  /** Street armed for the open board-card picker, if any. */
  boardChangeStreet: DealStreet | null;
  /** Browser-style back/forward stack of node + trail snapshots. */
  navHistory: NavHistoryEntry[];
  navHistoryIndex: number;
  canNavBack: boolean;
  canNavForward: boolean;
  goNavBack: () => Promise<void>;
  goNavForward: () => Promise<void>;
  /** Jump to an ancestor already present on the trail. */
  jumpTrailIndex: (index: number) => Promise<void>;
  /** Take a recorded alternative at a prior trail step. */
  takeTrailAlternative: (
    stepIndex: number,
    alternative: PathAlternative,
  ) => Promise<void>;
  nodeValues: ActionValuesPayload | null;
  runouts: unknown | null;
  equity: unknown | null;
  categories: unknown | null;
  /** Client-side solve gate errors (empty when valid / after a successful launch). */
  solveValidationErrors: string[];
  compareNote: ComparePayload | null;
  /** Scope the open strategy-edit draft is bound to; null when draft is idle. */
  strategyEditScope: StrategyEditScope | null;

  selectedCell: SelectedCell | null;
  hoverCell: SelectedCell | null;
  setSelectedCell: (cell: SelectedCell | null) => void;
  setHoverCell: (cell: SelectedCell | null) => void;
  frequencyMode: FrequencyMode;
  setFrequencyMode: (mode: FrequencyMode) => void;
  matrixMode: MatrixMode;
  setMatrixMode: (mode: MatrixMode) => void;
  /** UI display for action EV; engine payloads stay root_centered. Default local. */
  evDisplayBasis: "local" | "root_centered";
  setEvDisplayBasis: (basis: "local" | "root_centered") => void;
  actionFilter: number | null;
  setActionFilter: (index: number | null) => void;
  analysisTab: "explorer" | "runouts" | "equity" | "categories";
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
  navigateTo: (
    nodeId: string,
    opts?: { history?: "push" | "replace" | "none" },
  ) => Promise<void>;
  followAction: (nodeId: string) => Promise<void>;
  /**
   * Open-path gate for turn/river card changes from the board strip.
   * Resolves the matching deal-chance ancestor via `pathTrail` (preferred) or
   * walking `parent_id`, loads its payload for the picker, and returns the gate
   * result without navigating away from the current line.
   */
  prepareBoardCardChange: (street: DealStreet) => Promise<BoardCardChangeResult>;
  /** Clear armed board-card picker state (chance payload + street). */
  clearBoardCardChange: () => void;
  /**
   * Apply a picker selection: rewrite the current node's `.t`/`.r` from the
   * chance child's runout (keep public index N), navigate there, and fall back
   * to the chance child id on 400/404.
   */
  selectBoardCard: (chanceChildNodeId: string) => Promise<void>;
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

const rangeHistory = createExactRangeHistory();
type PaintStroke = {
  player: "oop" | "ip";
  weight: number;
  before: ExactPairSnapshot;
};
let paintStroke: PaintStroke | null = null;

function rangeKey(player: "oop" | "ip"): "oopRange" | "ipRange" {
  return player === "oop" ? "oopRange" : "ipRange";
}

function exactPairFromDraft(draft: { oopRange: string; ipRange: string }): ExactPairSnapshot {
  return exactPairFromTexts(draft.oopRange, draft.ipRange);
}

/** Test helper: drop paint-stroke + exact undo stacks without touching identity state. */
export function resetRangeEditHistoryForTests() {
  paintStroke = null;
  rangeHistory.clear();
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let nodeToken = 0;
let statusToken = 0;
let seenGeneration = -1;
let continuationPending = false;
/**
 * Where the next successful solution reload should land.
 * `null` = root (new solve / open). `undefined` = no preference (use current/root).
 */
let pendingReloadNodeId: string | null | undefined = undefined;

/** Independent tokens so equity polling does not cancel runouts (and vice versa). */
const analysisTokens: Record<AnalysisKind, number> = {
  values: 0,
  runouts: 0,
  equity: 0,
  categories: 0,
};
const analysisPollTimers: Partial<Record<AnalysisKind, ReturnType<typeof setInterval>>> = {};
const analysisRequestIdentity: Partial<Record<AnalysisKind, AnalysisIdentity>> = {};

type PublishedStudySnapshot = {
  solutionId: string | null;
  baselineSolutionId: string | null;
  currentNode: NodePayload | null;
  pathTrail: PathStep[];
  navHistory: NavHistoryEntry[];
  navHistoryIndex: number;
  canNavBack: boolean;
  canNavForward: boolean;
  nodeValues: ActionValuesPayload | null;
  runouts: unknown | null;
  equity: unknown | null;
  categories: unknown | null;
  compareNote: ComparePayload | null;
  strategyEditScope: StrategyEditScope | null;
  strategyEditDraft: StrategyEditDraft;
  strategyEditDraftBaseline: StrategyEditDraft | null;
  strategyEditDrawerOpen: boolean;
  selectedCell: SelectedCell | null;
  phase: SolvePhase;
  message: string;
  status: StatusPayload | null;
};

function strokeWeightForCell(current: number, slider: number): number {
  return slider <= 0 || Math.abs(current - slider) < 0.001 ? 0 : slider;
}

function clearAnalysisPoll(kind: AnalysisKind) {
  const timer = analysisPollTimers[kind];
  if (timer) {
    clearInterval(timer);
    delete analysisPollTimers[kind];
  }
}

function clearAllAnalysisPolls() {
  (Object.keys(analysisTokens) as AnalysisKind[]).forEach((kind) => {
    clearAnalysisPoll(kind);
  });
}

function bumpAnalysisToken(kind: AnalysisKind): number {
  analysisTokens[kind] += 1;
  clearAnalysisPoll(kind);
  delete analysisRequestIdentity[kind];
  return analysisTokens[kind];
}

function invalidateAllAnalysisRequests() {
  (Object.keys(analysisTokens) as AnalysisKind[]).forEach((kind) => {
    bumpAnalysisToken(kind);
  });
}

/** Invalidate in-flight node fetches so a delayed s1 payload cannot paint during s2. */
function bumpNodeToken(): number {
  nodeToken += 1;
  return nodeToken;
}

function bumpStatusToken(): number {
  statusToken += 1;
  return statusToken;
}

function invalidateLifecycleRequests() {
  bumpNodeToken();
  bumpStatusToken();
  invalidateAllAnalysisRequests();
}

function snapshotPublishedStudy(state: {
  solutionId: string | null;
  baselineSolutionId: string | null;
  currentNode: NodePayload | null;
  pathTrail: PathStep[];
  navHistory: NavHistoryEntry[];
  navHistoryIndex: number;
  canNavBack: boolean;
  canNavForward: boolean;
  nodeValues: ActionValuesPayload | null;
  runouts: unknown | null;
  equity: unknown | null;
  categories: unknown | null;
  compareNote: ComparePayload | null;
  strategyEditScope: StrategyEditScope | null;
  strategyEditDraft: StrategyEditDraft;
  strategyEditDraftBaseline: StrategyEditDraft | null;
  strategyEditDrawerOpen: boolean;
  selectedCell: SelectedCell | null;
  phase: SolvePhase;
  message: string;
  status: StatusPayload | null;
}): PublishedStudySnapshot {
  return {
    solutionId: state.solutionId,
    baselineSolutionId: state.baselineSolutionId,
    currentNode: state.currentNode,
    pathTrail: state.pathTrail.map((step) => ({ ...step })),
    navHistory: state.navHistory.map((entry) => ({
      nodeId: entry.nodeId,
      trail: entry.trail.map((step) => ({ ...step })),
    })),
    navHistoryIndex: state.navHistoryIndex,
    canNavBack: state.canNavBack,
    canNavForward: state.canNavForward,
    nodeValues: state.nodeValues,
    runouts: state.runouts,
    equity: state.equity,
    categories: state.categories,
    compareNote: state.compareNote,
    strategyEditScope: state.strategyEditScope,
    strategyEditDraft: structuredClone(state.strategyEditDraft),
    strategyEditDraftBaseline: state.strategyEditDraftBaseline
      ? structuredClone(state.strategyEditDraftBaseline)
      : null,
    strategyEditDrawerOpen: state.strategyEditDrawerOpen,
    selectedCell: state.selectedCell,
    phase: state.phase,
    message: state.message,
    status: state.status,
  };
}

function beginAnalysisRequest(
  kind: AnalysisKind,
  solutionId: string,
  nodeId: string,
  revision: number,
): { token: number; identity: AnalysisIdentity } {
  const token = bumpAnalysisToken(kind);
  const identity: AnalysisIdentity = { solutionId, nodeId, revision, kind };
  analysisRequestIdentity[kind] = identity;
  return { token, identity };
}

function analysisRequestIsCurrent(kind: AnalysisKind, token: number): boolean {
  return token === analysisTokens[kind];
}

/** Poll async analysis endpoints that may return `{ pending: true }` / HTTP 202. */
async function pollAnalysis<T extends { pending?: boolean }>(
  kind: AnalysisKind,
  token: number,
  fetchOnce: () => Promise<T>,
  onReady: (body: T) => void,
  onError: (message: string) => void,
): Promise<void> {
  const tick = async () => {
    try {
      const body = await fetchOnce();
      if (!analysisRequestIsCurrent(kind, token)) {
        return;
      }
      if (body && body.pending) {
        if (!analysisPollTimers[kind]) {
          analysisPollTimers[kind] = setInterval(() => {
            void tick();
          }, 250);
        }
        return;
      }
      clearAnalysisPoll(kind);
      onReady(body);
    } catch (error) {
      if (!analysisRequestIsCurrent(kind, token)) {
        return;
      }
      clearAnalysisPoll(kind);
      onError(error instanceof EngineError ? error.message : "Analysis request failed");
    }
  };
  await tick();
}

function emptyAnalysisState() {
  return {
    nodeValues: null as ActionValuesPayload | null,
    runouts: null as unknown | null,
    equity: null as unknown | null,
    categories: null as unknown | null,
  };
}

function analysisRevision(
  node: NodePayload | null | undefined,
  status: StatusPayload | null | undefined,
): number {
  if (typeof node?.status_generation === "number") {
    return node.status_generation;
  }
  if (typeof status?.status_generation === "number") {
    return status.status_generation;
  }
  return 0;
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
  draftRevision: initialRevision(0),
  setupMeta: null,
  canUndoSetup: false,
  updateDraft(partial) {
    set({
      draft: { ...get().draft, ...partial },
      draftRevision: bumpRevision(get().draftRevision),
    });
  },
  weights: {
    oop: parseRangeText(DEFAULT_SPOT.oopRange),
    ip: parseRangeText(DEFAULT_SPOT.ipRange),
  },
  setRangeText(player, text) {
    const draft = get().draft;
    const before = exactPairFromDraft(draft);
    const nextPair = exactPairFromTexts(
      player === "oop" ? text : draft.oopRange,
      player === "ip" ? text : draft.ipRange,
    );
    const weights = {
      ...get().weights,
      [player]: weightsFromExact(nextPair[player]),
    };
    rangeHistory.push(before);
    set({
      weights,
      draft: {
        ...draft,
        [rangeKey(player)]: text,
      },
      draftRevision: bumpRevision(get().draftRevision),
      canUndoRange: rangeHistory.canUndo(),
      canRedoRange: rangeHistory.canRedo(),
    });
  },
  applySetupDraft(result, options) {
    const state = get();
    const applied = applySetupTransaction({
      currentDraft: state.draft,
      currentWeights: state.weights,
      currentMeta: state.setupMeta,
      draftRevision: state.draftRevision,
      result,
      force: options?.force,
    });
    if (!applied.ok) {
      return { ok: false, reason: applied.reason, message: applied.message };
    }
    setupHistoryPast.push(applied.undoEntry);
    while (setupHistoryPast.length > SETUP_HISTORY_LIMIT) {
      setupHistoryPast.shift();
    }
    // Keep range undo stack coherent with exact texts before the setup apply.
    rangeHistory.push(exactPairFromDraft(state.draft));
    set({
      draft: applied.draft,
      weights: applied.weights,
      setupMeta: applied.meta,
      draftRevision: applied.draftRevision,
      canUndoSetup: setupHistoryPast.length > 0,
      canUndoRange: rangeHistory.canUndo(),
      canRedoRange: rangeHistory.canRedo(),
      message: applied.meta.summary[0] ?? "Setup applied",
    });
    return { ok: true, undoEntry: applied.undoEntry };
  },
  undoSetupTransaction() {
    const entry = setupHistoryPast.pop();
    if (!entry) {
      return { ok: false, reason: "empty" };
    }
    const state = get();
    const undone = undoSetupTransactionGuarded({
      currentDraft: state.draft,
      currentWeights: state.weights,
      currentMeta: state.setupMeta,
      draftRevision: state.draftRevision,
      entry,
    });
    set({
      draft: undone.draft,
      weights: undone.weights,
      setupMeta: undone.meta,
      draftRevision: undone.draftRevision,
      canUndoSetup: setupHistoryPast.length > 0,
      message: undone.message,
    });
    return {
      ok: true,
      message: undone.message,
      restoredKeys: undone.restoredKeys.map(String),
      conflictKeys: undone.conflictKeys.map(String),
    };
  },
  clearSetupMeta() {
    set({ setupMeta: null });
  },
  getSetupCatalogue() {
    return getRangeProfileCatalogue();
  },
  paintWeight: 1,
  setPaintWeight(weight) {
    set({ paintWeight: weight });
  },
  paintCell(player, row, column, weight) {
    if (paintStroke) {
      get().endPaintStroke();
    }
    const draft = get().draft;
    const before = exactPairFromDraft(draft);
    const nextWeight = weight === undefined ? get().paintWeight : weight;
    const current = get().weights[player][row][column];
    const applied = current === nextWeight ? 0 : nextWeight;
    const key = rangeKey(player);
    const painted = applyPaintAtPreservingExact(draft[key], row, column, applied);
    rangeHistory.push(before);
    set({
      weights: { ...get().weights, [player]: painted.grid },
      draft: {
        ...draft,
        [key]: painted.text,
      },
      draftRevision: bumpRevision(get().draftRevision),
      canUndoRange: rangeHistory.canUndo(),
      canRedoRange: rangeHistory.canRedo(),
    });
  },
  beginPaintStroke(player, row, column) {
    if (paintStroke) {
      get().endPaintStroke();
    }
    const slider = get().paintWeight;
    const current = get().weights[player][row][column];
    const weight = strokeWeightForCell(current, slider);
    paintStroke = {
      player,
      weight,
      before: exactPairFromDraft(get().draft),
    };
    get().continuePaintStroke(player, row, column);
  },
  continuePaintStroke(player, row, column) {
    if (!paintStroke || paintStroke.player !== player) {
      return;
    }
    const weight = paintStroke.weight;
    if (get().weights[player][row][column] === weight) {
      return;
    }
    const draft = get().draft;
    const key = rangeKey(player);
    const painted = applyPaintAtPreservingExact(draft[key], row, column, weight);
    set({
      weights: { ...get().weights, [player]: painted.grid },
      draft: {
        ...draft,
        [key]: painted.text,
      },
      draftRevision: bumpRevision(get().draftRevision),
    });
  },
  endPaintStroke() {
    if (!paintStroke) {
      return;
    }
    const before = paintStroke.before;
    paintStroke = null;
    const after = exactPairFromDraft(get().draft);
    if (!exactPairsEqual(before, after)) {
      rangeHistory.push(before);
      set({
        canUndoRange: rangeHistory.canUndo(),
        canRedoRange: rangeHistory.canRedo(),
      });
    }
  },
  clearRange(player) {
    const draft = get().draft;
    const before = exactPairFromDraft(draft);
    rangeHistory.push(before);
    set({
      weights: { ...get().weights, [player]: blankGrid() },
      draft: {
        ...draft,
        [rangeKey(player)]: "",
      },
      draftRevision: bumpRevision(get().draftRevision),
      canUndoRange: rangeHistory.canUndo(),
      canRedoRange: rangeHistory.canRedo(),
    });
  },
  undoRange() {
    const previous = rangeHistory.undo(exactPairFromDraft(get().draft));
    if (!previous) {
      return;
    }
    const texts = textsFromExactPair(previous);
    set({
      weights: weightsFromExactPair(previous),
      draft: {
        ...get().draft,
        oopRange: texts.oop,
        ipRange: texts.ip,
      },
      canUndoRange: rangeHistory.canUndo(),
      canRedoRange: rangeHistory.canRedo(),
    });
  },
  redoRange() {
    const next = rangeHistory.redo(exactPairFromDraft(get().draft));
    if (!next) {
      return;
    }
    const texts = textsFromExactPair(next);
    set({
      weights: weightsFromExactPair(next),
      draft: {
        ...get().draft,
        oopRange: texts.oop,
        ipRange: texts.ip,
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
  pathTrail: [],
  boardChangeChanceNode: null,
  boardChangeStreet: null,
  navHistory: [],
  navHistoryIndex: -1,
  canNavBack: false,
  canNavForward: false,
  async goNavBack() {
    const index = get().navHistoryIndex;
    if (index <= 0) {
      return;
    }
    const entry = get().navHistory[index - 1];
    if (!entry) {
      return;
    }
    set({
      navHistoryIndex: index - 1,
      canNavBack: index - 1 > 0,
      canNavForward: true,
      pathTrail: entry.trail.map((step) => ({ ...step })),
    });
    await get().navigateTo(entry.nodeId, { history: "none" });
  },
  async goNavForward() {
    const { navHistory, navHistoryIndex } = get();
    if (navHistoryIndex < 0 || navHistoryIndex >= navHistory.length - 1) {
      return;
    }
    const nextIndex = navHistoryIndex + 1;
    const entry = navHistory[nextIndex];
    if (!entry) {
      return;
    }
    set({
      navHistoryIndex: nextIndex,
      canNavBack: true,
      canNavForward: nextIndex < navHistory.length - 1,
      pathTrail: entry.trail.map((step) => ({ ...step })),
    });
    await get().navigateTo(entry.nodeId, { history: "none" });
  },
  async jumpTrailIndex(index: number) {
    const trail = get().pathTrail;
    const step = trail[index];
    if (!step?.nodeId) {
      return;
    }
    const nextTrail = trail.slice(0, index + 1).map((item) => ({ ...item }));
    set({ pathTrail: nextTrail });
    await get().navigateTo(step.nodeId, { history: "push" });
  },
  async takeTrailAlternative(stepIndex: number, alternative: PathAlternative) {
    if (!alternative.nodeId) {
      return;
    }
    // Alternative labels were compacted with the source pot when the step was
    // recorded; pot here is unused by replaceTrailAlternative.
    const potFallback = Number(
      get().status?.pot ?? get().draft.pot ?? 0,
    );
    const nextTrail = replaceTrailAlternative(
      get().pathTrail,
      stepIndex,
      alternative,
      potFallback,
    );
    if (!nextTrail) {
      return;
    }
    set({ pathTrail: nextTrail });
    await get().navigateTo(alternative.nodeId, { history: "push" });
  },
  nodeValues: null,
  runouts: null,
  equity: null,
  categories: null,
  solveValidationErrors: [],
  compareNote: null,
  strategyEditScope: null,

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
  evDisplayBasis: "local",
  setEvDisplayBasis(basis) {
    set({ evDisplayBasis: basis === "root_centered" ? "root_centered" : "local" });
  },
  actionFilter: null,
  setActionFilter(index) {
    set({ actionFilter: index });
  },
  analysisTab: "explorer",
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
    const node = get().currentNode;
    const solutionId = get().solutionId;
    if (!node || !solutionId) {
      set({ message: "Strategy edits require a published decision node." });
      return;
    }
    const scope = strategyEditScopeFromNode(solutionId, node);
    const existing = get().strategyEditDraft;
    const actions = node.actions?.length ?? 0;
    const scopeMatches = strategyEditScopesEqual(get().strategyEditScope, scope);
    const draft =
      scopeMatches && existing.probs.length === actions
        ? existing
        : defaultLockDraft(actions);
    set({
      strategyEditDrawerOpen: true,
      lockDrawerOpen: false,
      strategyEditScope: scope,
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
    const solutionId = get().solutionId;
    if (!node?.combos || !solutionId) {
      return;
    }
    const handIndices = combos
      .map((combo) => handIndexForCombo(node.combos, combo))
      .filter((index) => index >= 0);
    const unique = [...new Set(handIndices)].sort((a, b) => a - b);
    const actions = node.actions?.length ?? 0;
    const probs = seedProbsFromStrategy(node.strategy ?? null, unique, actions);
    const draft: StrategyEditDraft = { kind: "selected", handIndices: unique, probs };
    const scope = strategyEditScopeFromNode(solutionId, node);
    set({
      strategyEditDraft: draft,
      strategyEditDraftBaseline: structuredClone(draft),
      strategyEditScope: scope,
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
    const liveScope = strategyEditScopeFromNode(solutionId, node);
    if (!strategyEditScopesEqual(get().strategyEditScope, liveScope)) {
      set({
        message: "Strategy edit draft is out of date for this node — re-open the editor.",
        strategyEditScope: null,
        strategyEditDraft: defaultLockDraft(node.actions?.length ?? 0),
        strategyEditDraftBaseline: null,
        strategyEditDrawerOpen: false,
      });
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
    clearAllAnalysisPolls();
  },

  async refresh() {
    const token = ++statusToken;
    try {
      const status = await engineClient.status();
      // Drop overlapping / older in-flight polls before touching study state.
      if (!shouldApplyStatus(token, statusToken)) {
        return;
      }
      const decision = acceptStatusGeneration(status, seenGeneration, {
        // Token already proves this is the latest response; a lower generation
        // means the explorer process restarted and re-baselined the counter.
        allowRestart: true,
      });
      if (!decision.apply) {
        return;
      }
      seenGeneration = decision.generation;
      const reload = solutionNeedsReload(status, get().solutionId, continuationPending);
      const baselineSolutionId = resolveBaselineSolutionId(
        status.baseline_solution_id,
        get().baselineSolutionId,
      );
      const nextSolutionId = reload && status.solution_id
        ? status.solution_id
        : get().solutionId;
      const clearCompare = shouldClearCompareNote(
        get().compareNote,
        baselineSolutionId,
        nextSolutionId ?? status.solution_id,
      );
      set({
        status,
        connection: "connected",
        phase: phaseFromStatus(status, get().phase),
        baselineSolutionId,
        ...(clearCompare ? { compareNote: null } : {}),
      });
      if (reload && status.solution_id) {
        continuationPending = false;
        const reloadTarget =
          pendingReloadNodeId === undefined
            ? get().currentNode?.node_id || rootNodeId(status.root_node_id)
            : pendingReloadNodeId === null
              ? rootNodeId(status.root_node_id)
              : pendingReloadNodeId;
        pendingReloadNodeId = undefined;
        set({
          solutionId: status.solution_id,
          message: status.paused
            ? "Paused — browsing available. Continue to resume."
            : status.cancelled
              ? "Stopped — keeping completed iterations."
              : "Solve complete.",
        });
        await get().navigateTo(reloadTarget, { history: "replace" });
      } else if (status.running) {
        const requested = status.iterations_requested;
        const iterLabel =
          requested != null && Number(requested) > 0
            ? `${status.iterations ?? 0}/${requested}`
            : `${status.iterations ?? 0}`;
        set({
          message: status.paused
            ? "Pause requested — finishing current sample…"
            : `Solving — ${iterLabel} iterations`,
        });
      }
    } catch (error) {
      if (!shouldApplyStatus(token, statusToken)) {
        return;
      }
      const detail =
        error instanceof Error ? error.message : "Engine unreachable";
      let shellHint = "";
      if (isTauriRuntime()) {
        const shellStatus = await readEngineStatus();
        if (shellStatus) {
          shellHint = ` Shell: ${shellStatus}.`;
        }
      }
      set({
        connection: "disconnected",
        message: `Engine unreachable: ${detail}.${shellHint} Use Reconnect — the installer should have placed holdem-explorer beside the app.`,
      });
    }
  },

  async solve() {
    const validation = validateSetupForSolve(get().draft);
    if (!validation.ok) {
      // Client-side validation must not wipe a previous valid study.
      set({
        solveValidationErrors: validation.errors,
        message: `Cannot solve: ${validation.errors.join("; ")}`,
      });
      return;
    }
    const prior = snapshotPublishedStudy(get());
    invalidateLifecycleRequests();
    pendingReloadNodeId = null; // new solve always lands at root
    set({
      phase: "solving",
      message: "Solving…",
      solveValidationErrors: [],
      // Drop published identity so a delayed s1 node cannot rebind during s2.
      solutionId: null,
      currentNode: null,
      pathTrail: [],
      boardChangeChanceNode: null,
      boardChangeStreet: null,
      navHistory: [],
      navHistoryIndex: -1,
      canNavBack: false,
      canNavForward: false,
      ...emptyAnalysisState(),
      compareNote: null,
      strategyEditScope: null,
      strategyEditDraft: defaultLockDraft(0),
      strategyEditDraftBaseline: null,
      strategyEditDrawerOpen: false,
      selectedCell: null,
    });
    try {
      await engineClient.solve(buildJob(get().draft));
      continuationPending = true;
      get().startPolling();
      await get().refresh();
    } catch (error) {
      pendingReloadNodeId = undefined;
      set({
        ...prior,
        phase: "failed",
        message:
          error instanceof Error ? presentUserText(error.message) : "Solve failed",
        solveValidationErrors: [],
      });
    }
  },

  async continueSolve() {
    const solutionId = get().solutionId;
    if (!solutionId) {
      return;
    }
    const prior = snapshotPublishedStudy(get());
    const resumeNodeId = get().currentNode?.node_id ?? null;
    invalidateLifecycleRequests();
    pendingReloadNodeId = resumeNodeId;
    set({
      phase: "solving",
      message: "Continuing…",
      currentNode: null,
      ...emptyAnalysisState(),
      strategyEditScope: null,
      strategyEditDraft: defaultLockDraft(0),
      strategyEditDraftBaseline: null,
      strategyEditDrawerOpen: false,
    });
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
      pendingReloadNodeId = undefined;
      set({
        ...prior,
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
    const prior = snapshotPublishedStudy(get());
    const resumeNodeId = get().currentNode?.node_id ?? null;
    invalidateLifecycleRequests();
    pendingReloadNodeId = resumeNodeId;
    set({
      phase: "solving",
      message: get().warmStart
        ? "Resolving with locks (warm-start)…"
        : "Resolving with locks (reset)…",
      currentNode: null,
      ...emptyAnalysisState(),
      strategyEditScope: null,
      strategyEditDraft: defaultLockDraft(0),
      strategyEditDraftBaseline: null,
      strategyEditDrawerOpen: false,
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
      pendingReloadNodeId = undefined;
      set({
        ...prior,
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

  async navigateTo(nodeId: string, opts?: { history?: "push" | "replace" | "none" }) {
    // Bind to the live published solution only — do not fall back to a stale
    // status.solution_id while Solve/Open has cleared lifecycle identity.
    const solutionId = get().solutionId;
    if (!solutionId) {
      return;
    }
    const historyMode = opts?.history ?? "push";
    const token = bumpNodeToken();
    const previous = get().currentNode;
    // Drop every analysis result and in-flight poll so panels never show another node.
    invalidateAllAnalysisRequests();
    const priorScope = get().strategyEditScope;
    set({
      solutionId,
      ...emptyAnalysisState(),
      selectedCell: null,
      phase: get().status?.running ? get().phase : get().phase,
    });
    try {
      const node = await engineClient.getNode(solutionId, nodeId);
      // Compare against the live store solutionId only (no request fallback).
      if (!shouldApply(token, nodeToken, node.solution_id ?? solutionId, get().solutionId)) {
        return;
      }
      if (typeof node.status_generation === "number" && node.status_generation < seenGeneration) {
        return;
      }
const rootId = get().status?.root_node_id || rootNodeId(undefined);
      // Size tags use the source node's pot/basis inside advancePathTrail /
      // edgeStepFromNode; pass previous pot only as a fallback when missing.
      const potFallback = Number(
        previous?.pot ?? get().status?.pot ?? get().draft.pot ?? 0,
      );
      let pathTrail = get().pathTrail;
      if (historyMode !== "none") {
        pathTrail = advancePathTrail(
          pathTrail,
          previous,
          node,
          potFallback,
          rootId,
        );
        if (!pathTrail.length || pathTrail[0]?.nodeId !== rootId) {
          pathTrail = [
            rootPathStep(rootId, node.board, String(node.place ?? "")),
            ...pathTrail.filter((step) => step.kind !== "root"),
          ];
        }
        // Landing on root resets the trail.
        if (node.node_id === rootId) {
          pathTrail = [rootPathStep(rootId, node.board, String(node.place ?? ""))];
        }
      }

      let navHistory = get().navHistory;
      let navHistoryIndex = get().navHistoryIndex;
      if (historyMode === "push" || historyMode === "replace") {
        const entry = {
          nodeId: node.node_id,
          trail: pathTrail.map((step) => ({ ...step })),
        };
        if (historyMode === "replace" && navHistoryIndex >= 0 && navHistory[navHistoryIndex]) {
          const copy = navHistory.slice();
          copy[navHistoryIndex] = entry;
          navHistory = copy;
        } else {
          const pushed = pushNavHistory(navHistory, navHistoryIndex, entry);
          navHistory = pushed.entries;
          navHistoryIndex = pushed.index;
        }
      }

      const nextSolutionId = node.solution_id ?? solutionId;
      const nextScope = strategyEditScopeFromNode(nextSolutionId, node);
      // Only reset when identity changes — never silently rebind hand indices.
      const strategyScopeChanged =
        priorScope != null && !strategyEditScopesEqual(priorScope, nextScope);
      set({
        currentNode: node,
        solutionId: nextSolutionId,
        frequencyMode: "aggression",
        actionFilter: null,
        lockDraft: defaultLockDraft(node.actions?.length ?? 0),
        lockDraftBaseline: defaultLockDraft(node.actions?.length ?? 0),
pathTrail,
        navHistory,
        navHistoryIndex,
        canNavBack: navHistoryIndex > 0,
        canNavForward: navHistoryIndex >= 0 && navHistoryIndex < navHistory.length - 1,
        ...(strategyScopeChanged
          ? {
              strategyEditScope: null,
              strategyEditDraft: defaultLockDraft(node.actions?.length ?? 0),
              strategyEditDraftBaseline: null,
              strategyEditDrawerOpen: false,
            }
          : priorScope == null
            ? {
                // Keep draft empty/unscoped until the drawer opens on this node.
                strategyEditScope: null,
              }
            : {
                // Same identity (e.g. re-publish after apply): keep draft bound.
                strategyEditScope: nextScope,
              }),
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
    await get().navigateTo(nodeId, { history: "push" });
  },

  clearBoardCardChange() {
    set({ boardChangeChanceNode: null, boardChangeStreet: null });
  },

  async prepareBoardCardChange(street: DealStreet) {
    const current = get().currentNode;
    const solutionId = get().solutionId;

    const finish = (result: BoardCardChangeResult, chance: NodePayload | null) => {
      if (!result.ok) {
        set({
          message: result.reason,
          boardChangeChanceNode: null,
          boardChangeStreet: null,
        });
        return result;
      }
      set({
        boardChangeChanceNode: chance,
        boardChangeStreet: street,
      });
      return result;
    };

    if (isDealChanceForStreet(current, street)) {
      const result = evaluateBoardCardChange(current, street);
      return finish(result, result.ok ? current : null);
    }

    // Prefer pathTrail: step before the street's card deal is the chance node.
    let chanceId = resolveDealChanceIdFromTrail(get().pathTrail, street);
    let chanceNode: NodePayload | null = null;

    const loadChance = async (nodeId: string): Promise<NodePayload | null> => {
      if (!solutionId) {
        return null;
      }
      try {
        return await engineClient.getNode(solutionId, nodeId);
      } catch {
        return null;
      }
    };

    if (chanceId && chanceId !== current?.node_id) {
      chanceNode = await loadChance(chanceId);
      if (chanceNode && isDealChanceForStreet(chanceNode, street)) {
        const result = evaluateBoardCardChange(current, street, chanceNode);
        return finish(result, result.ok ? chanceNode : null);
      }
      chanceNode = null;
    }

    // Fallback: walk parent_id toward the deal-chance ancestor.
    if (current && solutionId) {
      const seen = new Set<string>();
      let cursor: NodePayload | null = current;
      let depth = 0;
      while (cursor && depth < 64) {
        const parentId =
          typeof cursor.parent_id === "string" && cursor.parent_id.length > 0
            ? cursor.parent_id
            : null;
        if (!parentId || seen.has(parentId)) {
          break;
        }
        seen.add(parentId);
        const parent = await loadChance(parentId);
        if (!parent) {
          break;
        }
        if (isDealChanceForStreet(parent, street)) {
          chanceNode = parent;
          chanceId = parent.node_id;
          break;
        }
        cursor = parent;
        depth += 1;
      }
    }

    const result = evaluateBoardCardChange(current, street, chanceNode);
    return finish(result, result.ok ? chanceNode : null);
  },

  async selectBoardCard(chanceChildNodeId: string) {
    const current = get().currentNode;
    const chance = get().boardChangeChanceNode;
    const solutionId = get().solutionId;
    if (!current || !chance || !chanceChildNodeId || !solutionId) {
      return;
    }
    let target = linePreservingCardTargetId(
      current.node_id,
      chance.node_id,
      chanceChildNodeId,
    );
    // Probe rewritten id; on 400/404 fall back to the chance child (deal root of that runout).
    if (target !== chanceChildNodeId) {
      try {
        await engineClient.getNode(solutionId, target);
      } catch (error) {
        const status = error instanceof EngineError ? error.status : 0;
        if (status === 400 || status === 404) {
          target = chanceChildNodeId;
        } else {
          set({
            boardChangeChanceNode: null,
            boardChangeStreet: null,
            message:
              error instanceof EngineError
                ? error.message
                : "Board card navigation failed",
          });
          return;
        }
      }
    }
    set({ boardChangeChanceNode: null, boardChangeStreet: null });
    await get().navigateTo(target, { history: "push" });
  },

  async calculateEv() {
    const solutionId = get().solutionId;
    const node = get().currentNode;
    if (!solutionId || !node) {
      return;
    }
    const revision = analysisRevision(node, get().status);
    const { token, identity } = beginAnalysisRequest(
      "values",
      solutionId,
      node.node_id,
      revision,
    );
    set({
      phase: "analysis_pending",
      message: "Calculating action EVs…",
      nodeValues: { pending: true, node_id: node.node_id, solution_id: solutionId },
    });
    await pollAnalysis(
      "values",
      token,
      () => engineClient.getValues(solutionId, node.node_id),
      (values) => {
        if (!analysisRequestIsCurrent("values", token)) {
          return;
        }
        const live = get().currentNode;
        const liveSolution = get().solutionId;
        if (
          !live ||
          live.node_id !== identity.nodeId ||
          liveSolution !== identity.solutionId
        ) {
          return;
        }
        if (values.node_id && values.node_id !== identity.nodeId) {
          return;
        }
        set({
          nodeValues: values,
          phase: phaseFromStatus(get().status, "complete"),
          message: "Action EVs ready.",
          matrixMode: get().matrixMode === "strategy" ? "strategy-ev" : get().matrixMode,
        });
      },
      (message) => {
        if (!analysisRequestIsCurrent("values", token)) {
          return;
        }
        set({
          phase: phaseFromStatus(get().status, "complete"),
          message,
          nodeValues: null,
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
    const revision = analysisRevision(node, get().status);
    const { token, identity } = beginAnalysisRequest(
      "runouts",
      solutionId,
      node.node_id,
      revision,
    );
    set({
      message: "Loading runouts…",
      analysisTab: "runouts",
      runouts: { pending: true, node_id: node.node_id, solution_id: solutionId },
    });
    await pollAnalysis(
      "runouts",
      token,
      () =>
        engineClient.getRunouts(solutionId, node.node_id) as Promise<{
          pending?: boolean;
          node_id?: string;
          solution_id?: string;
        }>,
      (runouts) => {
        if (!analysisRequestIsCurrent("runouts", token)) {
          return;
        }
        const live = get().currentNode;
        if (
          !live ||
          live.node_id !== identity.nodeId ||
          get().solutionId !== identity.solutionId
        ) {
          return;
        }
        if (runouts.node_id && runouts.node_id !== identity.nodeId) {
          return;
        }
        set({ runouts, message: "Runouts ready." });
      },
      (message) => {
        if (!analysisRequestIsCurrent("runouts", token)) {
          return;
        }
        set({ message, runouts: null });
      },
    );
  },

  async loadEquity() {
    const solutionId = get().solutionId;
    const node = get().currentNode;
    if (!solutionId || !node) {
      return;
    }
    const revision = analysisRevision(node, get().status);
    const { token, identity } = beginAnalysisRequest(
      "equity",
      solutionId,
      node.node_id,
      revision,
    );
    set({
      message: "Loading equity…",
      analysisTab: "equity",
      equity: { pending: true, node_id: node.node_id, solution_id: solutionId },
    });
    await pollAnalysis(
      "equity",
      token,
      () =>
        engineClient.getEquity(solutionId, node.node_id) as Promise<{
          pending?: boolean;
          node_id?: string;
          solution_id?: string;
        }>,
      (equity) => {
        if (!analysisRequestIsCurrent("equity", token)) {
          return;
        }
        const live = get().currentNode;
        if (
          !live ||
          live.node_id !== identity.nodeId ||
          get().solutionId !== identity.solutionId
        ) {
          return;
        }
        if (equity.node_id && equity.node_id !== identity.nodeId) {
          return;
        }
        set({ equity, message: "Equity ready." });
      },
      (message) => {
        if (!analysisRequestIsCurrent("equity", token)) {
          return;
        }
        set({ message, equity: null });
      },
    );
  },

  async loadCategories() {
    const solutionId = get().solutionId;
    const node = get().currentNode;
    if (!solutionId || !node) {
      return;
    }
    const revision = analysisRevision(node, get().status);
    const { token, identity } = beginAnalysisRequest(
      "categories",
      solutionId,
      node.node_id,
      revision,
    );
    set({
      message: "Loading categories…",
      analysisTab: "categories",
      categories: { pending: true, node_id: node.node_id, solution_id: solutionId },
    });
    await pollAnalysis(
      "categories",
      token,
      () =>
        engineClient.getCategories(solutionId, node.node_id) as Promise<{
          pending?: boolean;
          node_id?: string;
          solution_id?: string;
        }>,
      (categories) => {
        if (!analysisRequestIsCurrent("categories", token)) {
          return;
        }
        const live = get().currentNode;
        if (
          !live ||
          live.node_id !== identity.nodeId ||
          get().solutionId !== identity.solutionId
        ) {
          return;
        }
        if (categories.node_id && categories.node_id !== identity.nodeId) {
          return;
        }
        set({ categories, message: "Categories ready." });
      },
      (message) => {
        if (!analysisRequestIsCurrent("categories", token)) {
          return;
        }
        set({ message, categories: null });
      },
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
    const prior = snapshotPublishedStudy(get());
    invalidateLifecycleRequests();
    pendingReloadNodeId = null; // opened checkpoint lands at root
    // Drop cross-solution Build undo / nav before the load completes.
    setupHistoryPast.length = 0;
    rangeHistory.past.length = 0;
    rangeHistory.future.length = 0;
    set({
      phase: "loading",
      message: `Opening ${target}…`,
      solutionId: null,
      currentNode: null,
      pathTrail: [],
      boardChangeChanceNode: null,
      boardChangeStreet: null,
      navHistory: [],
      navHistoryIndex: -1,
      canNavBack: false,
      canNavForward: false,
      ...emptyAnalysisState(),
      compareNote: null,
      strategyEditScope: null,
      strategyEditDraft: defaultLockDraft(0),
      strategyEditDraftBaseline: null,
      strategyEditDrawerOpen: false,
      setupMeta: null,
      canUndoSetup: false,
      canUndoRange: false,
      canRedoRange: false,
      selectedCell: null,
    });
    try {
      await engineClient.open(target);
      continuationPending = true;
      get().startPolling();
      await get().refresh();
      // Replace Build draft wholesale from solution config + status — never merge
      // into the previous draft (avoids 22s over an AA solution, stale time limits).
      const status = get().status;
      const solutionId = get().solutionId;
      let config: Record<string, unknown> | null = null;
      if (solutionId) {
        try {
          config = await engineClient.getSolutionConfig(solutionId);
        } catch {
          config = null;
        }
      }
      const opened = draftFromOpenedSolution({
        solutionPath: target,
        status,
        config,
      });
      const weights = {
        oop: parseRangeText(opened.draft.oopRange),
        ip: parseRangeText(opened.draft.ipRange),
      };
      const warningSuffix =
        opened.warnings.length > 0 ? ` ${opened.warnings.join(" ")}` : "";
      const syncNote = opened.configComplete
        ? "Build draft replaced from solution config."
        : "Build draft replaced from status; ranges/bet sizes cleared.";
      set({
        draft: opened.draft,
        weights,
        draftRevision: bumpRevision(get().draftRevision),
        pathTrail: [],
        boardChangeChanceNode: null,
        boardChangeStreet: null,
        navHistory: [],
        navHistoryIndex: -1,
        canNavBack: false,
        canNavForward: false,
        compareNote: null,
        strategyEditScope: null,
        strategyEditDraft: defaultLockDraft(0),
        strategyEditDraftBaseline: null,
        strategyEditDrawerOpen: false,
        setupMeta: null,
        canUndoSetup: false,
        canUndoRange: false,
        canRedoRange: false,
        message: `Opened ${target}. ${syncNote}${warningSuffix}`,
      });
    } catch (error) {
      // Missing/invalid checkpoint must leave the last valid study usable.
      pendingReloadNodeId = undefined;
      set({
        ...prior,
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
        compareNote: null,
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
      if (
        !compareNoteIsValid(compareNote, baseline, scenario, targetNode)
      ) {
        set({
          compareNote: null,
          message:
            "Compare response identity did not match the requested baseline/scenario/node.",
        });
        return;
      }
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
