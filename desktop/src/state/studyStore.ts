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
  draftBuildSpotFromStudy,
  evaluateBuildSpotEligibility,
} from "../domain/build/transferFromStudy";
import {
  lineCardOptionsFromChance,
  lineCardReportStreet,
  lineCardTargetId,
  rowFromResolvedNode,
  unavailableRow,
  withLineCardReportFilter,
  type LineCardReportActiveFilter,
  type LineCardReportModel,
  type LineCardReportRow,
} from "../domain/lineCardReport";
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
  lockMutationCompletion,
  normalizeProbs,
  seedProbsFromStrategy,
  setLinkedActionProb,
  toggleHandIndex,
  type ComparePayload,
  type LockDraft,
  type LockRecord,
  type LocksPayload,
} from "../domain/locks";
import {
  captureCompareRequestScope,
  captureStudyMutationScope,
  classifyStatusPollError,
  compareRequestIsCurrent,
  createTimeoutSignal,
  nextStatusPollDelay,
  statusPollFailureDetail,
  STATUS_POLL_TIMEOUT_MS,
  studyMutationScopeIsCurrent,
} from "../domain/requestScope";
import {
  classifyStrategyEditFailure,
  strategyMutationCompletion,
  type StrategyEditDraft,
  type StrategyEditRecord,
  type StrategyEditsPayload,
} from "../domain/strategyEdits";
import {
  classifyEngineSessionFault,
  canOfferReopenLastCheckpoint,
  coldReconnectMessage,
  ensureFailedRecoveryMessage,
  isRecoveryOrUnreachableMessage,
  lastValidCheckpointPath,
  normalizeStatusForPhase,
  phaseAfterSessionFault,
  reconnectedMessage,
  reconnectingMessage,
  sessionDeadUiPatch,
  shouldMarkStatusPollDead,
  shouldTerminateHungSidecar,
  statusIndicatesFailure,
  statusStickyError,
} from "../domain/sessionRecovery";
import { killSolverEngineIpc } from "../engine/transport";
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
  recomputeSetupSolveReadiness,
  resolveBaselineSolutionId,
  shouldClearCompareNote,
  strategyEditScopeFromNode,
  strategyEditScopesEqual,
  undoSetupTransactionGuarded,
  validateSetupForSolve,
  type SetupDraftResult,
  type SetupStudyMeta,
  type SetupUndoEntry,
  type StrategyEditScope,
} from "../domain/setup";
import { draftFromFullTemplate } from "../domain/setup/templateApply";
import { getRangeProfileCatalogue } from "../domain/profiles";
import { EngineError, engineClient } from "../engine/client";
import {
  studyIpcFeatureAvailable,
  studyIpcUnavailableReason,
  type StudyIpcFeature,
} from "../engine/ipcCapabilities";
import { isTauriRuntime } from "../platform";
import {
  boardLenFromStatusBoard,
  clearSolveFaultDedupe,
  reportSolveFailedFault,
} from "../platform/diagnostics";
import { ensureEngine, readEngineStatus } from "../platform/engine";

function rejectUnavailableIpcFeature(feature: StudyIpcFeature): string | null {
  if (studyIpcFeatureAvailable(feature)) {
    return null;
  }
  return studyIpcUnavailableReason(feature);
}
import { useThemeStore } from "./themeStore";
import { useLayoutStore } from "./layoutStore";
import {
  analysisErrorIsPermanent,
  analysisRequestIsCurrent,
  analysisRevision,
  beginAnalysisRequest,
  bumpAnalysisPrefetchEpoch,
  bumpNodeToken,
  bumpStatusToken,
  cachedAnalysisForNode,
  dropAnalysisCaches,
  enqueueWorkerAnalysis,
  invalidateAllAnalysisRequests,
  getAnalysisPageCache,
  getAnalysisPrefetchEpoch,
  getAnalysisRequestQueue,
  getNodeToken,
  getSeenGeneration,
  getStatusAbortController,
  getStatusConsecutiveFailures,
  getStatusInFlight,
  getStatusToken,
  invalidateLifecycleRequests,
  isStatusPollActive,
  isStatusRefreshQueued,
  pollAnalysis,
  resetAnalysisCacheForTests,
  resetStatusPollingForTests,
  scheduleStatusPoll,
  setSeenGeneration,
  setStatusAbortController,
  setStatusConsecutiveFailures,
  setStatusInFlight,
  setStatusRefreshQueued,
  startStatusPolling,
  stopStatusPolling,
} from "./studySessionController";

import {
  phaseFromStatus,
  rootNodeId,
  buildJob,
} from "./studyDraft";

/** Typed result for transactional Open — failure preserves path + undo. */
export type OpenSolutionResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

/** Typed result for transactional Save — failure keeps the previous path. */
export type SaveSolutionResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

const SETUP_HISTORY_LIMIT = 30;
const setupHistoryPast: SetupUndoEntry[] = [];

/** Test helper: drop assistant setup undo stack without touching draft state. */
export function resetSetupHistoryForTests() {
  setupHistoryPast.length = 0;
}

export type WorkspaceId = "study" | "build" | "compare" | "library" | "equity";

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
  /** Swap OOP ↔ IP range text and grids (one undo step). Layout unchanged. */
  swapRanges: () => void;
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
  /**
   * Path of the last successful Save or Open (ZR-157). Independent of the
   * editable draft.solutionPath so typed-but-never-opened paths cannot drive
   * Reopen last checkpoint.
   */
  lastCheckpointPath: string;
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
  equity: unknown | null;
  categories: unknown | null;
  lineCardReport: LineCardReportModel | null;
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
  analysisTab: "equity" | "categories" | "value-bluffs" | "line-cards";
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
  /** Linked slider: set one action and redistribute the rest to sum to 1. */
  setLockProbLinked: (index: number, value: number) => void;
  toggleLockHand: (handIndex: number) => void;
  selectCombosForLock: (combos: string[]) => void;
  clearLockSelection: () => void;
  selectAllCombosForLock: () => void;
  seedLockFromStrategy: () => void;
  revertLockDraft: () => void;
  refreshLocks: () => Promise<void>;
  applyLock: (scope?: "node" | "line") => Promise<boolean>;
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
  /**
   * Durable recovery: stop polls, clear sticky busy/cancel, re-ensure engine,
   * restart status. Used by Reconnect and after session-dead faults (ZR-123).
   */
  recoverEngineSession: () => Promise<{ ok: boolean; error?: string }>;
  /** Mark unreachable + clear sticky busy without re-ensure (Reconnect follows). */
  markEngineSessionDead: (
    detail: string,
    opts?: { message?: string },
  ) => void;
  /**
   * Reopen the last successful Save/Open checkpoint (ZR-157). Re-ensures the
   * engine first when the session is disconnected/connecting.
   */
  reopenLastCheckpoint: () => Promise<OpenSolutionResult>;
  refresh: () => Promise<void>;
  solve: () => Promise<void>;
  continueSolve: () => Promise<void>;
  resolveLocked: () => Promise<void>;
  pause: () => Promise<void>;
  stop: () => Promise<void>;
  navigateTo: (
    nodeId: string,
    opts?: {
      history?: "push" | "replace" | "none";
      /** Keep selected hand, action filter, and display modes across card hops. */
      preserveStudySelection?: boolean;
    },
  ) => Promise<void>;
  followAction: (nodeId: string) => Promise<void>;
  /**
   * Build a same-line card report for the current decision (vary turn or river).
   * Opens the Line cards analysis tab. Optional filter/sort is applied after load.
   */
  loadLineCardReport: (opts?: {
    filter?: LineCardReportActiveFilter | null;
  }) => Promise<void>;
  /** Apply or clear filter/sort on the loaded Compare-runouts report. */
  applyLineCardReportFilter: (
    filter: LineCardReportActiveFilter | null,
  ) => void;
  /** Navigate to a report row's resolved node while preserving Study selection. */
  openLineCardRow: (resolvedNodeId: string) => Promise<void>;
  /**
   * Create a Build draft from the current street-start turn/river decision
   * (raw reaching ranges, pot, effective stack) and open Build for review.
   */
  createBuildSpotFromHere: () => Promise<void>;
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
  loadEquity: () => Promise<void>;
  loadCategories: () => Promise<void>;
  /**
   * Always-on Study warm: enqueue equity then action EVs for the live decision
   * node. Safe to call on every navigate — cache hits and in-flight jobs no-op.
   */
  ensureNodeAnalysis: () => Promise<void>;
  saveSolution: (path?: string) => Promise<SaveSolutionResult>;
  openSolution: (path?: string) => Promise<OpenSolutionResult>;
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

/** Re-export session controller test hooks for existing test imports. */
export { resetStatusPollingForTests, resetAnalysisCacheForTests };

let continuationPending = false;
/**
 * Where the next successful solution reload should land.
 * `null` = root (new solve / open). `undefined` = no preference (use current/root).
 */
let pendingReloadNodeId: string | null | undefined = undefined;

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

function emptyAnalysisState() {
  return {
    nodeValues: null as ActionValuesPayload | null,
    equity: null as unknown | null,
    categories: null as unknown | null,
    lineCardReport: null as LineCardReportModel | null,
  };
}

/** True when a Tauri train RPC waiter hit its ceiling while the sidecar may still train. */
function isEngineIpcTimeout(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return /timed out/i.test(message);
}

/**
 * Cancel a leftover in-flight train before begin_config (ZR-106).
 * A prior timed-out solve RPC can leave phase=training and Busy the next begin.
 */
async function stopOrphanTrainIfRunning(): Promise<void> {
  try {
    const status = await engineClient.status();
    if (!status.running) {
      return;
    }
    try {
      await engineClient.stop();
    } catch {
      // No minted job id / already stopped — status poll will converge.
    }
    for (let i = 0; i < 50; i += 1) {
      const next = await engineClient.status();
      if (!next.running) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch {
    // Unreachable engine — let the subsequent solve surface the error.
  }
}

/**
 * Soft-recover train RPC timeout: keep Solving and let status polling finish
 * the lifecycle instead of restoring the prior study and leaving a sticky Busy.
 */
async function recoverTrainRpcTimeout(
  get: () => { refresh: () => Promise<void>; startPolling: () => void },
  error: unknown,
): Promise<boolean> {
  if (!isEngineIpcTimeout(error)) {
    return false;
  }
  try {
    const status = await engineClient.status();
    if (status.running || status.paused || status.solution_id) {
      continuationPending = true;
      get().startPolling();
      await get().refresh();
      return true;
    }
  } catch {
    // Fall through to hard failure.
  }
  return false;
}

let lineCardReportToken = 0;

/** Decision nodes get always-on EV/equity; chance/terminal do not. */
function isDecisionNodeForAnalysis(
  node: NodePayload | null | undefined,
): node is NodePayload {
  if (!node) {
    return false;
  }
  if (node.kind === "chance" || node.kind === "terminal") {
    return false;
  }
  return (
    node.kind === "decision" ||
    node.kind == null ||
    (node.actions?.length ?? 0) > 0
  );
}

function analysisHasError(payload: unknown): boolean {
  return Boolean(
    payload &&
      typeof payload === "object" &&
      "error" in payload &&
      (payload as { error?: unknown }).error,
  );
}

function analysisIsReadyForNode(
  payload: { pending?: boolean; node_id?: string; solution_id?: string; error?: string } | null,
  solutionId: string,
  nodeId: string,
): boolean {
  if (!payload || payload.pending || analysisHasError(payload)) {
    return false;
  }
  if (payload.node_id != null && payload.node_id !== nodeId) {
    return false;
  }
  if (payload.solution_id != null && payload.solution_id !== solutionId) {
    return false;
  }
  return true;
}

/** Resolve a child node id from a decision node's `children` entry. */
function childNodeIdAt(children: unknown[] | undefined, index: number): string | null {
  if (!children) {
    return null;
  }
  const child = children[index];
  if (!child) {
    return null;
  }
  if (typeof child === "string") {
    return child;
  }
  if (
    typeof child === "object" &&
    child !== null &&
    "node_id" in child &&
    typeof (child as { node_id?: unknown }).node_id === "string" &&
    (child as { node_id: string }).node_id
  ) {
    return (child as { node_id: string }).node_id;
  }
  return null;
}

/** Warm child decision /values in the background after the live node is ready. */
function prefetchChildValues(
  solutionId: string,
  node: NodePayload,
  revision: number,
): void {
  const children = node.children;
  if (!children?.length) {
    return;
  }
  for (let index = 0; index < children.length; index += 1) {
    const childId = childNodeIdAt(children, index);
    if (!childId) {
      continue;
    }
    if (
      getAnalysisPageCache().get({
        solutionId,
        nodeId: childId,
        revision,
        kind: "values",
      })
    ) {
      continue;
    }
    const epoch = getAnalysisPrefetchEpoch();
    enqueueWorkerAnalysis({
      kind: "values",
      solutionId,
      nodeId: childId,
      revision,
      priority: "prefetch",
      run: async () => {
        // Prefetch only fills the cache; navigateTo restores it onto the live node.
        if (epoch !== getAnalysisPrefetchEpoch()) {
          return;
        }
        try {
          let body: ActionValuesPayload | null = null;
          for (let attempt = 0; attempt < 120 && !body; attempt += 1) {
            if (epoch !== getAnalysisPrefetchEpoch()) {
              return;
            }
            const page = await engineClient.getValues(solutionId, childId);
            if (page && !page.pending) {
              body = page;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          if (body && epoch === getAnalysisPrefetchEpoch()) {
            getAnalysisPageCache().set(
              { solutionId, nodeId: childId, revision, kind: "values" },
              body,
            );
          }
        } catch {
          // Prefetch failures are silent — user/auto paths paint errors.
        }
      },
    });
  }
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
    const draft = { ...get().draft, ...partial };
    set({
      draft,
      draftRevision: bumpRevision(get().draftRevision),
      // Keep setupMeta.canSolve / missing coherent after manual edits so a
      // board completed after an incomplete assistant apply unblocks Solve.
      setupMeta: recomputeSetupSolveReadiness(get().setupMeta, draft),
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
  swapRanges() {
    const draft = get().draft;
    const before = exactPairFromDraft(draft);
    const nextPair = exactPairFromTexts(draft.ipRange, draft.oopRange);
    if (exactPairsEqual(before, nextPair)) {
      return;
    }
    rangeHistory.push(before);
    set({
      weights: weightsFromExactPair(nextPair),
      draft: {
        ...draft,
        oopRange: draft.ipRange,
        ipRange: draft.oopRange,
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
  lastCheckpointPath: "",
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
  equity: null,
  categories: null,
  lineCardReport: null,
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
  analysisTab: "equity",
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
  setLockProbLinked(index, value) {
    const probs = setLinkedActionProb(get().lockDraft.probs, index, value);
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
  clearLockSelection() {
    set({
      lockDraft: {
        ...get().lockDraft,
        kind: "selected",
        handIndices: [],
      },
    });
  },
  selectAllCombosForLock() {
    const node = get().currentNode;
    if (!node?.combos?.length) {
      return;
    }
    const handIndices = node.combos.map((_, index) => index);
    const actions = node.actions?.length ?? 0;
    const probs = seedProbsFromStrategy(node.strategy ?? null, handIndices, actions);
    set({
      lockDraft: {
        kind: "selected",
        handIndices,
        probs,
      },
    });
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
      // Solution identity must still match; node may have moved within it.
      if (get().solutionId !== solutionId) {
        return;
      }
      set({ locks: payload.locks || [] });
    } catch (error) {
      if (get().solutionId !== solutionId) {
        return;
      }
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
  async applyLock(scope: "node" | "line" = "node") {
    const solutionId = get().solutionId;
    const node = get().currentNode;
    if (!solutionId || !node || node.kind !== "decision") {
      set({ message: "Locks require a published decision node." });
      return false;
    }
    const draft = structuredClone(get().lockDraft);
    if (draft.kind === "selected" && draft.handIndices.length === 0) {
      set({ message: "Select at least one combo, or switch to full-node lock." });
      return false;
    }
    const normalized = normalizeProbs(draft.probs);
    if (!normalized.valid) {
      set({
        message: normalized.reason || "Lock probabilities are invalid.",
      });
      return false;
    }
    try {
      const body =
        draft.kind === "full"
          ? {
              node_id: node.node_id,
              kind: "full" as const,
              scope,
              probs: normalized.probs,
            }
          : {
              node_id: node.node_id,
              kind: "selected" as const,
              scope,
              hand_indices: draft.handIndices,
              probs: normalized.probs,
            };
      const payload = (await engineClient.putLock(solutionId, body)) as LocksPayload;
      const live = get();
      const completion = lockMutationCompletion({
        requestSolutionId: solutionId,
        requestNodeId: node.node_id,
        liveSolutionId: live.solutionId,
        liveNodeId: live.currentNode?.node_id,
      });
      if (!completion.applyLocksList) {
        return false;
      }
      const scopeLabel = scope === "line" ? "line (all runouts)" : "node";
      if (completion.applyDraft) {
        set({
          locks: payload.locks || [],
          lockDraft: { ...draft, probs: normalized.probs },
          lockDraftBaseline: structuredClone({ ...draft, probs: normalized.probs }),
          message:
            draft.kind === "full"
              ? `Full ${scopeLabel} lock applied at ${node.node_id}`
              : `Locked ${draft.handIndices.length} combo(s) on ${scopeLabel} at ${node.node_id}`,
        });
      } else {
        // Same solution, different node — keep locks list, discard draft write.
        set({
          locks: payload.locks || [],
          message: `Lock applied at ${node.node_id} (draft not restored; node changed).`,
        });
      }
      return true;
    } catch (error) {
      if (get().solutionId !== solutionId) {
        return false;
      }
      set({
        message: error instanceof EngineError ? error.message : "Lock failed",
      });
      return false;
    }
  },
  async unlockHands(handIndices) {
    const solutionId = get().solutionId;
    const node = get().currentNode;
    if (!solutionId || !node) {
      return;
    }
    const requestNodeId = node.node_id;
    const active = lockForNode(get().locks, requestNodeId);
    const deleteNodeId = active?.node_id ?? requestNodeId;
    const targets = handIndices ?? get().lockDraft.handIndices;
    if (!targets.length) {
      set({ message: "No combo selected to unlock." });
      return;
    }
    try {
      for (const handIndex of targets) {
        await engineClient.deleteLock(solutionId, deleteNodeId, handIndex);
      }
      if (get().solutionId !== solutionId) {
        return;
      }
      await get().refreshLocks();
      if (
        !studyMutationScopeIsCurrent(
          captureStudyMutationScope({ solutionId, nodeId: requestNodeId }),
          {
            solutionId: get().solutionId,
            nodeId: get().currentNode?.node_id,
          },
        )
      ) {
        return;
      }
      set({ message: `Unlocked ${targets.length} combo(s) at ${requestNodeId}` });
    } catch (error) {
      if (get().solutionId !== solutionId) {
        return;
      }
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
    const requestNodeId = node.node_id;
    // Prefer deleting the active lock record (exact runout or line fallback).
    const active = lockForNode(get().locks, requestNodeId);
    const deleteNodeId = active?.node_id ?? requestNodeId;
    try {
      await engineClient.deleteLock(solutionId, deleteNodeId);
      if (get().solutionId !== solutionId) {
        return;
      }
      await get().refreshLocks();
      if (get().currentNode?.node_id !== requestNodeId) {
        return;
      }
      set({ message: `Cleared locks at ${deleteNodeId}` });
    } catch (error) {
      if (get().solutionId !== solutionId) {
        return;
      }
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
      if (get().solutionId !== solutionId) {
        return;
      }
      await get().refreshLocks();
      if (get().solutionId !== solutionId) {
        return;
      }
      set({ message: "Cleared all locks on this solution." });
    } catch (error) {
      if (get().solutionId !== solutionId) {
        return;
      }
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
    const unavailable = rejectUnavailableIpcFeature("strategyEdits");
    if (unavailable) {
      set({ message: unavailable, strategyEditDrawerOpen: false });
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
    const unavailable = rejectUnavailableIpcFeature("strategyEdits");
    if (unavailable) {
      set({ strategyEdits: [], message: unavailable });
      return;
    }
    const solutionId = get().solutionId;
    if (!solutionId) {
      set({ strategyEdits: [] });
      return;
    }
    try {
      const payload = (await engineClient.listStrategyEdits(solutionId)) as StrategyEditsPayload;
      if (get().solutionId !== solutionId) {
        return;
      }
      set({ strategyEdits: payload.edits || [] });
    } catch (error) {
      if (get().solutionId !== solutionId) {
        return;
      }
      set({
        message:
          error instanceof EngineError ? error.message : "Failed to list strategy edits",
      });
    }
  },
  async applyStrategyEdit() {
    const unavailable = rejectUnavailableIpcFeature("strategyEdits");
    if (unavailable) {
      set({ message: unavailable });
      return;
    }
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
    const requestNodeId = node.node_id;
    const draft = structuredClone(get().strategyEditDraft);
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
              node_id: requestNodeId,
              kind: "full" as const,
              probs: normalized.probs,
            }
          : {
              node_id: requestNodeId,
              kind: "selected" as const,
              hand_indices: draft.handIndices,
              probs: normalized.probs,
            };
      const payload = (await engineClient.putStrategyEdit(
        solutionId,
        body,
      )) as StrategyEditsPayload;
      // Profile changed under the same solution id — drop cached EV/equity pages.
      getAnalysisPageCache().clearSolution(solutionId);
      getAnalysisRequestQueue().cancelQueued(
        (job) => job.solutionId === solutionId && job.kind === "values",
      );
      const live = get();
      const completion = strategyMutationCompletion({
        requestSolutionId: solutionId,
        requestNodeId,
        liveSolutionId: live.solutionId,
        liveNodeId: live.currentNode?.node_id,
      });
      if (!completion.applyEditsList) {
        return;
      }
      if (completion.applyDraft) {
        set({
          strategyEdits: payload.edits || [],
          strategyEditDraft: { ...draft, probs: normalized.probs },
          strategyEditDraftBaseline: structuredClone({
            ...draft,
            probs: normalized.probs,
          }),
          message:
            draft.kind === "full"
              ? `Full-node strategy edit applied at ${requestNodeId}`
              : `Edited ${draft.handIndices.length} combo(s) at ${requestNodeId}`,
        });
      } else {
        set({
          strategyEdits: payload.edits || [],
          message: `Strategy edit applied at ${requestNodeId} (draft not restored; node changed).`,
        });
      }
      if (completion.reloadNode) {
        await get().navigateTo(requestNodeId);
      }
    } catch (error) {
      if (get().solutionId !== solutionId) {
        return;
      }
      // ZR-119 classifier + ZR-123 durable sticky clear / Reconnect path.
      const classified = classifyStrategyEditFailure(error);
      if (classified.sessionDead) {
        get().markEngineSessionDead(classified.detail, {
          message: classified.message,
        });
        return;
      }
      set({ message: classified.message });
    }
  },
  async clearStrategyEditHands(handIndices) {
    const unavailable = rejectUnavailableIpcFeature("strategyEdits");
    if (unavailable) {
      set({ message: unavailable });
      return;
    }
    const solutionId = get().solutionId;
    const node = get().currentNode;
    if (!solutionId || !node) {
      return;
    }
    const requestNodeId = node.node_id;
    const targets = handIndices ?? get().strategyEditDraft.handIndices;
    if (!targets.length) {
      set({ message: "No combo selected to clear." });
      return;
    }
    try {
      for (const handIndex of targets) {
        await engineClient.deleteStrategyEdit(solutionId, requestNodeId, handIndex);
      }
      if (get().solutionId !== solutionId) {
        return;
      }
      await get().refreshStrategyEdits();
      const completion = strategyMutationCompletion({
        requestSolutionId: solutionId,
        requestNodeId,
        liveSolutionId: get().solutionId,
        liveNodeId: get().currentNode?.node_id,
      });
      if (!completion.reloadNode) {
        return;
      }
      await get().navigateTo(requestNodeId);
      set({ message: `Cleared ${targets.length} strategy edit(s) at ${requestNodeId}` });
    } catch (error) {
      if (get().solutionId !== solutionId) {
        return;
      }
      const classified = classifyStrategyEditFailure(error);
      if (classified.sessionDead) {
        get().markEngineSessionDead(classified.detail, {
          message: classified.message,
        });
        return;
      }
      set({ message: classified.message });
    }
  },
  async clearStrategyEditNode() {
    const unavailable = rejectUnavailableIpcFeature("strategyEdits");
    if (unavailable) {
      set({ message: unavailable });
      return;
    }
    const solutionId = get().solutionId;
    const node = get().currentNode;
    if (!solutionId || !node) {
      return;
    }
    const requestNodeId = node.node_id;
    try {
      await engineClient.deleteStrategyEdit(solutionId, requestNodeId);
      if (get().solutionId !== solutionId) {
        return;
      }
      await get().refreshStrategyEdits();
      const completion = strategyMutationCompletion({
        requestSolutionId: solutionId,
        requestNodeId,
        liveSolutionId: get().solutionId,
        liveNodeId: get().currentNode?.node_id,
      });
      if (!completion.reloadNode) {
        return;
      }
      await get().navigateTo(requestNodeId);
      set({ message: `Cleared strategy edits at ${requestNodeId}` });
    } catch (error) {
      if (get().solutionId !== solutionId) {
        return;
      }
      const classified = classifyStrategyEditFailure(error);
      if (classified.sessionDead) {
        get().markEngineSessionDead(classified.detail, {
          message: classified.message,
        });
        return;
      }
      set({ message: classified.message });
    }
  },
  async clearAllStrategyEdits() {
    const unavailable = rejectUnavailableIpcFeature("strategyEdits");
    if (unavailable) {
      set({ message: unavailable });
      return;
    }
    const solutionId = get().solutionId;
    if (!solutionId) {
      return;
    }
    try {
      await engineClient.deleteStrategyEdit(solutionId);
      if (get().solutionId !== solutionId) {
        return;
      }
      await get().refreshStrategyEdits();
      if (get().solutionId !== solutionId) {
        return;
      }
      const nodeId = get().currentNode?.node_id;
      if (nodeId) {
        await get().navigateTo(nodeId);
      }
      if (get().solutionId !== solutionId) {
        return;
      }
      set({ message: "Cleared all strategy edits on this solution." });
    } catch (error) {
      if (get().solutionId !== solutionId) {
        return;
      }
      const classified = classifyStrategyEditFailure(error);
      if (classified.sessionDead) {
        get().markEngineSessionDead(classified.detail, {
          message: classified.message,
        });
        return;
      }
      set({ message: classified.message });
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
    startStatusPolling(() => {
      void get().refresh();
    });
  },
  stopPolling() {
    stopStatusPolling();
  },

  markEngineSessionDead(detail, opts) {
    continuationPending = false;
    pendingReloadNodeId = undefined;
    invalidateLifecycleRequests();
    // Failed/orphan job id must not outlive the dead pipe (ZR-143).
    engineClient.clearLastStudyJobId();
    const patch = sessionDeadUiPatch({
      detail,
      phase: get().phase,
      solutionId: get().solutionId,
    });
    if (opts?.message?.trim()) {
      patch.message = opts.message.trim();
    }
    set(patch);
    // ZR-160 / ZR-163: persist last-fault for the diagnostics zip (best-effort).
    clearSolveFaultDedupe();
    void reportSolveFailedFault({
      reason: detail,
      exitReason: "session-dead",
      lastOp: "status",
    });
  },

  async recoverEngineSession() {
    get().stopPolling();
    continuationPending = false;
    pendingReloadNodeId = undefined;
    invalidateLifecycleRequests();
    dropAnalysisCaches();
    // Cold sidecar must not cancel/stop against a pre-death job id.
    engineClient.clearLastStudyJobId();
    const priorPhase = get().phase;
    const hadSolution = Boolean(get().solutionId);
    const checkpointPath = lastValidCheckpointPath(
      get().draft.solutionPath,
      get().lastCheckpointPath,
    );
    set({
      connection: "connecting",
      message: reconnectingMessage(),
      phase: phaseAfterSessionFault(priorPhase, { hadSolution }),
      status: null,
    });
    const result = await ensureEngine();
    if (!result.ok) {
      set({
        connection: "disconnected",
        message: ensureFailedRecoveryMessage(result.error),
        phase: phaseAfterSessionFault(get().phase, {
          hadSolution: Boolean(get().solutionId),
        }),
      });
      clearSolveFaultDedupe();
      void reportSolveFailedFault({
        reason: result.error,
        exitReason: "reconnect-ensure-fail",
        lastOp: "ensure",
      });
      return { ok: false, error: result.error };
    }
    const label =
      result.transport.kind === "ipc" ? result.transport.label : result.status;
    set({
      connection: "connected",
      message: reconnectedMessage(label),
    });
    get().startPolling();
    await get().refresh();
    // Fresh engine has no published solution — drop stale Study identity.
    // Restart alone never restores unsaved train progress (ZR-143).
    const status = get().status;
    if (!status?.solution_id) {
      set({
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
        ...emptyAnalysisState(),
        strategyEditScope: null,
        strategyEditDraft: defaultLockDraft(0),
        strategyEditDraftBaseline: null,
        strategyEditDrawerOpen: false,
        compareNote: null,
        // Cold host after crash: prior "failed" was the dead session, not a
        // sticky train fault on this sidecar. Keep lastCheckpointPath so
        // Reopen last checkpoint can reload the last successful Save/Open.
        phase: "idle",
        message: coldReconnectMessage({
          label,
          solutionPath: checkpointPath || undefined,
        }),
      });
    }
    return { ok: true };
  },

  async reopenLastCheckpoint() {
    const checkpointPath = get().lastCheckpointPath.trim();
    if (!canOfferReopenLastCheckpoint(checkpointPath)) {
      const error =
        "No last checkpoint — Save or Open a .psol before Reopen last checkpoint.";
      set({ message: error });
      return { ok: false, error };
    }
    const connection = get().connection;
    if (connection === "disconnected" || connection === "connecting") {
      const recovered = await get().recoverEngineSession();
      if (!recovered.ok) {
        return {
          ok: false,
          error: recovered.error ?? "Engine reconnect failed",
        };
      }
    }
    return get().openSolution(checkpointPath);
  },

  async refresh() {
    if (getStatusInFlight()) {
      setStatusRefreshQueued(true);
      await getStatusInFlight();
      // If the owner finished before draining our queue, take ownership.
      if (!getStatusInFlight() && isStatusRefreshQueued()) {
        return get().refresh();
      }
      return;
    }

    const runCycle = async () => {
      let outcome: "success" | "failure" | "shutdown_cancel" = "success";
      do {
        setStatusRefreshQueued(false);
        const token = bumpStatusToken();
        const abort = new AbortController();
        setStatusAbortController(abort);
        const timed = createTimeoutSignal(STATUS_POLL_TIMEOUT_MS, abort.signal);
        try {
          const status = await engineClient.status(timed.signal);
          // Drop superseded responses (invalidateLifecycleRequests bumped token).
          if (!shouldApplyStatus(token, getStatusToken())) {
            continue;
          }
          const decision = acceptStatusGeneration(status, getSeenGeneration(), {
            // Token already proves this is the latest response; a lower generation
            // means the explorer process restarted and re-baselined the counter.
            allowRestart: true,
          });
          if (!decision.apply) {
            continue;
          }
          setSeenGeneration(decision.generation);
          setStatusConsecutiveFailures(0);
          outcome = "success";
          const normalized = normalizeStatusForPhase(status);
          const prior = get();
          const nextPhase = phaseFromStatus(normalized, prior.phase);
          const reload = solutionNeedsReload(
            normalized,
            prior.solutionId,
            continuationPending,
          );
          const baselineSolutionId = resolveBaselineSolutionId(
            normalized.baseline_solution_id,
            prior.baselineSolutionId,
          );
          const nextSolutionId =
            reload && normalized.solution_id
              ? normalized.solution_id
              : prior.solutionId;
          const clearCompare = shouldClearCompareNote(
            prior.compareNote,
            baselineSolutionId,
            nextSolutionId ?? normalized.solution_id,
          );
          const failed = statusIndicatesFailure(normalized);
          const sticky = statusStickyError(normalized);
          // Clear stale unreachable / reconnect copy once live status returns.
          const clearUnreachable =
            prior.connection !== "connected" ||
            isRecoveryOrUnreachableMessage(prior.message);
          let liveMessage: string | undefined;
          if (failed) {
            liveMessage = sticky
              ? presentUserText(sticky)
              : "Solve failed.";
            // ZR-163: host sticky last_error / phase=failed must write last-fault
            // even when pipes stay alive (no session-dead). Deduped per sticky key.
            void reportSolveFailedFault({
              reason: sticky ?? "Solve failed.",
              exitReason: "solve-failed",
              iterations: normalized.iterations,
              boardLen:
                boardLenFromStatusBoard(normalized.board) ??
                boardLenFromStatusBoard(prior.draft.boardText),
              lastOp: "status",
            });
          } else if (reload && normalized.solution_id) {
            liveMessage = normalized.paused
              ? "Paused — browsing available. Continue to resume."
              : normalized.cancelled
                ? "Stopped — keeping completed iterations."
                : "Solve complete.";
          } else if (normalized.running) {
            const hostPhase =
              typeof normalized.phase === "string"
                ? normalized.phase.toLowerCase()
                : "";
            if (hostPhase === "compiling" || nextPhase === "building") {
              liveMessage = "Building public tree…";
            } else if (
              nextPhase === "pause_requested" ||
              (normalized.paused && normalized.running)
            ) {
              liveMessage = "Pause requested — finishing current sample…";
            } else if (nextPhase === "stop_requested") {
              liveMessage = "Stop requested — finishing current sample…";
            } else {
              const requested = normalized.iterations_requested;
              const iterLabel =
                requested != null && Number(requested) > 0
                  ? `${normalized.iterations ?? 0}/${requested}`
                  : `${normalized.iterations ?? 0}`;
              liveMessage = `Solving — ${iterLabel} iterations`;
            }
          } else if (clearUnreachable) {
            liveMessage =
              nextPhase === "complete"
                ? "Solve complete."
                : nextPhase === "paused"
                  ? "Paused — browsing available. Continue to resume."
                  : "Engine ready.";
          }
          set({
            status: normalized,
            connection: "connected",
            phase: nextPhase,
            baselineSolutionId,
            ...(clearCompare ? { compareNote: null } : {}),
            ...(liveMessage !== undefined ? { message: liveMessage } : {}),
          });
          if (reload && normalized.solution_id) {
            continuationPending = false;
            const reloadTarget =
              pendingReloadNodeId === undefined
                ? get().currentNode?.node_id || rootNodeId(normalized.root_node_id)
                : pendingReloadNodeId === null
                  ? rootNodeId(normalized.root_node_id)
                  : pendingReloadNodeId;
            pendingReloadNodeId = undefined;
            set({
              solutionId: normalized.solution_id,
            });
            await get().navigateTo(reloadTarget, { history: "replace" });
          }
        } catch (error) {
          const classified = classifyStatusPollError(error, {
            pollActive: isStatusPollActive(),
            timedOut: timed.timedOut(),
          });
          outcome = classified.kind;
          if (classified.kind === "shutdown_cancel") {
            return;
          }
          if (!shouldApplyStatus(token, getStatusToken())) {
            continue;
          }
          setStatusConsecutiveFailures(getStatusConsecutiveFailures() + 1);
          const detail = statusPollFailureDetail(error, {
            timedOut: timed.timedOut(),
          });
          let shellHint = "";
          if (isTauriRuntime()) {
            const shellStatus = await readEngineStatus();
            if (!shouldApplyStatus(token, getStatusToken()) || !isStatusPollActive()) {
              continue;
            }
            if (shellStatus) {
              shellHint = ` Shell: ${shellStatus}.`;
            }
          }
          const fullDetail = shellHint ? `${detail}.${shellHint}` : detail;
          // Soft blips: backoff only. Hard session-dead or N consecutive
          // failures: paint disconnected + clear sticky busy (ZR-123 / ZR-148).
          // ZR-151: when hung, terminate the sidecar so Reconnect can spawn fresh.
          if (
            shouldMarkStatusPollDead({
              consecutiveFailures: getStatusConsecutiveFailures(),
              detail: fullDetail,
            })
          ) {
            if (
              shouldTerminateHungSidecar({
                consecutiveFailures: getStatusConsecutiveFailures(),
                detail: fullDetail,
              })
            ) {
              void killSolverEngineIpc();
            }
            get().markEngineSessionDead(fullDetail);
          }
        } finally {
          timed.dispose();
          if (getStatusAbortController() === abort) {
            setStatusAbortController(null);
          }
        }
      } while (isStatusRefreshQueued() && isStatusPollActive());

            if (isStatusPollActive()) {
        const delay = nextStatusPollDelay({
          outcome,
          consecutiveFailures: getStatusConsecutiveFailures(),
        });
        scheduleStatusPoll(delay, () => {
          void get().refresh();
        });
      }
    };

    setStatusInFlight(runCycle().finally(() => {
      setStatusInFlight(null);
    }));
    await getStatusInFlight();
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
    dropAnalysisCaches();
    pendingReloadNodeId = null; // new solve always lands at root
    set({
      // Host begin_config may report phase=compiling (ZR-120); polling maps that
      // to Building, then Solving once train is admitted with live iterations.
      phase: "building",
      message: "Building public tree…",
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
    // Poll before begin+admit so status (iterations / compiling) stays live while
    // the host compiles off-stdin and short-admits train (ZR-106 / ZR-120).
    // Await admit only — completion is owned by status polling, not this RPC.
    continuationPending = true;
    clearSolveFaultDedupe();
    get().startPolling();
    try {
      await stopOrphanTrainIfRunning();
      await engineClient.solve(buildJob(get().draft));
      await get().refresh();
    } catch (error) {
      if (await recoverTrainRpcTimeout(get, error)) {
        return;
      }
      pendingReloadNodeId = undefined;
      const fault = classifyEngineSessionFault(error);
      if (fault.sessionDead) {
        get().markEngineSessionDead(fault.detail);
        return;
      }
      const message =
        error instanceof Error ? presentUserText(error.message) : "Solve failed";
      set({
        ...prior,
        phase: "failed",
        message,
        solveValidationErrors: [],
      });
      void reportSolveFailedFault({
        reason: message,
        exitReason: "solve-rpc-failed",
        boardLen: boardLenFromStatusBoard(get().draft.boardText),
        lastOp: "solve",
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
    dropAnalysisCaches();
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
    continuationPending = true;
    get().startPolling();
    try {
      const body: { iterations: number; time_limit?: number } = {
        iterations: get().draft.iterations,
      };
      if (get().draft.timeLimit.trim() !== "") {
        body.time_limit = Number(get().draft.timeLimit);
      }
      await engineClient.continueSolve(solutionId, body);
      await get().refresh();
    } catch (error) {
      if (await recoverTrainRpcTimeout(get, error)) {
        return;
      }
      pendingReloadNodeId = undefined;
      const fault = classifyEngineSessionFault(error);
      if (fault.sessionDead) {
        get().markEngineSessionDead(fault.detail);
        return;
      }
      const message =
        error instanceof EngineError ? error.message : "Continue failed";
      set({
        ...prior,
        phase: "failed",
        message,
      });
      void reportSolveFailedFault({
        reason: message,
        exitReason: "solve-rpc-failed",
        boardLen: boardLenFromStatusBoard(get().draft.boardText),
        lastOp: "continue",
      });
    }
  },

  async resolveLocked() {
    const unavailable = rejectUnavailableIpcFeature("resolveLocked");
    if (unavailable) {
      set({ message: unavailable });
      return;
    }
    const solutionId = get().solutionId;
    if (!solutionId) {
      return;
    }
    const prior = snapshotPublishedStudy(get());
    const resumeNodeId = get().currentNode?.node_id ?? null;
    invalidateLifecycleRequests();
    dropAnalysisCaches();
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
    continuationPending = true;
    get().startPolling();
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
      await get().refresh();
    } catch (error) {
      if (await recoverTrainRpcTimeout(get, error)) {
        return;
      }
      pendingReloadNodeId = undefined;
      const fault = classifyEngineSessionFault(error);
      if (fault.sessionDead) {
        get().markEngineSessionDead(fault.detail);
        return;
      }
      const message =
        error instanceof EngineError ? error.message : "Resolve locked failed";
      set({
        ...prior,
        phase: "failed",
        message,
      });
      void reportSolveFailedFault({
        reason: message,
        exitReason: "solve-rpc-failed",
        boardLen: boardLenFromStatusBoard(get().draft.boardText),
        lastOp: "resolve_locked",
      });
    }
  },

  async pause() {
    set({ phase: "pause_requested", message: "Pausing after the current sample…" });
    try {
      await engineClient.pause();
    } catch (error) {
      const fault = classifyEngineSessionFault(error);
      if (fault.sessionDead) {
        get().markEngineSessionDead(fault.detail);
        return;
      }
      set({
        message: error instanceof EngineError ? error.message : "Pause failed",
        // Soft pause failure must not leave sticky pause_requested forever.
        phase: phaseFromStatus(get().status, get().phase === "pause_requested" ? "solving" : get().phase),
      });
    }
  },

  async stop() {
    set({ phase: "stop_requested", message: "Stopping after the current sample…" });
    try {
      await engineClient.stop();
    } catch (error) {
      const fault = classifyEngineSessionFault(error);
      if (fault.sessionDead) {
        get().markEngineSessionDead(fault.detail);
        return;
      }
      set({
        message: error instanceof EngineError ? error.message : "Stop failed",
        // Soft stop failure must not leave sticky stop_requested forever.
        phase: phaseFromStatus(get().status, get().phase === "stop_requested" ? "solving" : get().phase),
      });
    }
  },

  async navigateTo(
    nodeId: string,
    opts?: {
      history?: "push" | "replace" | "none";
      preserveStudySelection?: boolean;
    },
  ) {
    // Bind to the live published solution only — do not fall back to a stale
    // status.solution_id while Solve/Open has cleared lifecycle identity.
    const solutionId = get().solutionId;
    if (!solutionId) {
      return;
    }
    const historyMode = opts?.history ?? "push";
    const preserveStudySelection = Boolean(opts?.preserveStudySelection);
    const token = bumpNodeToken();
    const previous = get().currentNode;
    const preserved = preserveStudySelection
      ? {
          selectedCell: get().selectedCell,
          actionFilter: get().actionFilter,
          frequencyMode: get().frequencyMode,
          matrixMode: get().matrixMode,
          lineCardReport: get().lineCardReport,
        }
      : null;
    // Cancel in-flight polls and drop queued auto/prefetch work for other nodes.
    // Keep the page cache so returning to a node restores EV/equity instantly.
    invalidateAllAnalysisRequests();
    bumpAnalysisPrefetchEpoch();
    getAnalysisRequestQueue().cancelQueued((job) => job.priority !== "user");
    const priorScope = get().strategyEditScope;
    set({
      solutionId,
      ...emptyAnalysisState(),
      ...(preserved
        ? { selectedCell: preserved.selectedCell, lineCardReport: preserved.lineCardReport }
        : { selectedCell: null }),
      phase: get().status?.running ? get().phase : get().phase,
    });
    try {
      const node = await engineClient.getNode(solutionId, nodeId);
      // Compare against the live store solutionId only (no request fallback).
      if (!shouldApply(token, getNodeToken(), node.solution_id ?? solutionId, get().solutionId)) {
        return;
      }
      if (typeof node.status_generation === "number" && node.status_generation < getSeenGeneration()) {
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
      const revision = analysisRevision(node, get().status);
      const cached = cachedAnalysisForNode(nextSolutionId, node.node_id, revision);
      set({
        currentNode: node,
        solutionId: nextSolutionId,
        frequencyMode: preserved?.frequencyMode ?? "aggression",
        actionFilter: preserved?.actionFilter ?? null,
        matrixMode: preserved?.matrixMode ?? get().matrixMode,
        selectedCell: preserved?.selectedCell ?? null,
        lockDraft: defaultLockDraft(node.actions?.length ?? 0),
        lockDraftBaseline: defaultLockDraft(node.actions?.length ?? 0),
        pathTrail,
        navHistory,
        navHistoryIndex,
        canNavBack: navHistoryIndex > 0,
        canNavForward: navHistoryIndex >= 0 && navHistoryIndex < navHistory.length - 1,
        ...cached,
        ...(preserved?.lineCardReport
          ? { lineCardReport: preserved.lineCardReport }
          : {}),
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
      // Always warm EV + equity for decision nodes (cache / queue make this cheap).
      void get().ensureNodeAnalysis();
    } catch (error) {
      if (token !== getNodeToken()) {
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

  async openLineCardRow(resolvedNodeId: string) {
    if (!resolvedNodeId) {
      return;
    }
    await get().navigateTo(resolvedNodeId, {
      history: "push",
      preserveStudySelection: true,
    });
  },

  applyLineCardReportFilter(filter) {
    const report = get().lineCardReport;
    if (!report || report.pending) {
      return;
    }
    set({
      lineCardReport: withLineCardReportFilter(report, filter),
    });
  },

  async loadLineCardReport(opts) {
    const solutionId = get().solutionId;
    const node = get().currentNode;
    if (!solutionId || !node) {
      set({ message: "Solve a spot before comparing cards on a line." });
      return;
    }
    if (node.kind === "chance" || node.kind === "terminal") {
      set({
        message: "Open a decision node to compare action frequencies across cards.",
      });
      return;
    }
    const street = lineCardReportStreet(node.board);
    if (!street) {
      set({
        message: "Compare runouts needs a turn or river board (flop-only spots have no card to vary).",
      });
      return;
    }

    const token = ++lineCardReportToken;
    const reportNodeId = node.node_id;
    const actionLabels = [...(node.actions ?? [])];
    const pendingFilter = opts?.filter ?? null;
    const pending: LineCardReportModel = {
      pending: true,
      reportNodeId,
      line: String(node.line || reportNodeId),
      street,
      chanceNodeId: "",
      actionLabels,
      rows: [],
      solutionId,
      activeFilter: pendingFilter,
    };
    set({
      lineCardReport: pending,
      analysisTab: "line-cards",
      message: `Comparing ${street} cards on this line…`,
    });
    useLayoutStore.getState().setLayout({
      lowerDock: true,
      lowerDockHeight: Math.max(
        useLayoutStore.getState().layout.lowerDockHeight,
        480,
      ),
    });

    try {
      const gate = await get().prepareBoardCardChange(street);
      if (token !== lineCardReportToken) {
        return;
      }
      if (!gate.ok) {
        set({
          lineCardReport: {
            ...pending,
            pending: false,
            error: gate.reason,
          },
          message: gate.reason,
        });
        return;
      }
      const chance = get().boardChangeChanceNode;
      if (!chance) {
        set({
          lineCardReport: {
            ...pending,
            pending: false,
            error: `Could not load the ${street} deal node.`,
          },
          message: `Could not load the ${street} deal node.`,
        });
        return;
      }
      // Picker arming is only for the report; clear so the strip stays idle.
      get().clearBoardCardChange();

      // Re-check identity before publishing rows (solution may have changed).
      if (get().solutionId !== solutionId || get().currentNode?.node_id !== reportNodeId) {
        set({
          lineCardReport: {
            ...pending,
            pending: false,
            error:
              "Study solution or decision changed while building Compare runouts. Retry on the intended decision.",
          },
          message:
            "Study solution or decision changed while building Compare runouts. Retry on the intended decision.",
        });
        return;
      }

      const options = lineCardOptionsFromChance(chance);
      const rows: LineCardReportRow[] = [];
      for (const option of options) {
        if (token !== lineCardReportToken) {
          return;
        }
        if (get().solutionId !== solutionId || get().currentNode?.node_id !== reportNodeId) {
          set({
            lineCardReport: {
              ...pending,
              pending: false,
              error:
                "Study solution or decision changed while building Compare runouts. Retry on the intended decision.",
            },
            message:
              "Study solution or decision changed while building Compare runouts. Retry on the intended decision.",
          });
          return;
        }
        const target = lineCardTargetId(
          reportNodeId,
          chance.node_id,
          option.nodeId,
        );
        try {
          const resolved = await engineClient.getNode(solutionId, target);
          if (token !== lineCardReportToken) {
            return;
          }
          if (
            resolved.kind === "chance" ||
            resolved.kind === "terminal" ||
            !(resolved.actions?.length)
          ) {
            rows.push(
              unavailableRow(option, "Decision not present on this card"),
            );
            continue;
          }
          rows.push(rowFromResolvedNode(option, resolved, actionLabels));
        } catch (error) {
          const status = error instanceof EngineError ? error.status : 0;
          if (status === 400 || status === 404) {
            rows.push(unavailableRow(option, "Line unavailable on this card"));
            continue;
          }
          throw error;
        }
      }

      if (token !== lineCardReportToken) {
        return;
      }
      if (get().solutionId !== solutionId || get().currentNode?.node_id !== reportNodeId) {
        set({
          lineCardReport: {
            ...pending,
            pending: false,
            error:
              "Study solution or decision changed while building Compare runouts. Retry on the intended decision.",
          },
          message:
            "Study solution or decision changed while building Compare runouts. Retry on the intended decision.",
        });
        return;
      }
      const base: LineCardReportModel = {
        pending: false,
        reportNodeId,
        line: String(node.line || reportNodeId),
        street,
        chanceNodeId: chance.node_id,
        actionLabels,
        rows,
        solutionId,
      };
      const next = withLineCardReportFilter(base, pendingFilter);
      set({
        lineCardReport: next,
        analysisTab: "line-cards",
        message: next.matchedCards
          ? `Line card report ready (${next.matchedCards.length} matched ${street}s).`
          : `Line card report ready (${rows.length} ${street}s).`,
      });
    } catch (error) {
      if (token !== lineCardReportToken) {
        return;
      }
      const message =
        error instanceof EngineError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Line card report failed";
      set({
        lineCardReport: {
          ...pending,
          pending: false,
          error: message,
        },
        message,
      });
    }
  },

  async createBuildSpotFromHere() {
    const node = get().currentNode;
    const solutionId = get().solutionId;
    const gate = evaluateBuildSpotEligibility(node);
    if (!gate.ok) {
      set({ message: gate.reason });
      return;
    }
    if (!node || !solutionId) {
      set({ message: "Solve a spot before creating a Build draft from Study." });
      return;
    }
    set({ message: "Creating Build spot from this decision…" });
    let config: Record<string, unknown> | null = null;
    try {
      config = await engineClient.getSolutionConfig(solutionId);
    } catch {
      config = null;
    }
    const transferred = draftBuildSpotFromStudy({
      node,
      solutionId,
      pathTrail: get().pathTrail,
      config,
      prefsDraft: get().draft,
    });
    if (!transferred.ok) {
      set({ message: transferred.reason });
      return;
    }
    // Optional: compare legal root actions via tree-preview.
    let actionNote = "";
    try {
      const preview = await engineClient.treePreview(buildJob(transferred.draft));
      const root = preview.nodes.find((entry) => !entry.terminal && !entry.chance);
      const previewLabels = (root?.actions ?? []).map((action) => action.label);
      const source = transferred.sourceActions;
      const missing = source.filter((label) => !previewLabels.includes(label));
      const extra = previewLabels.filter((label) => !source.includes(label));
      if (missing.length || extra.length) {
        actionNote = ` Root actions differ from source${
          missing.length ? ` (missing ${missing.join(", ")})` : ""
        }${extra.length ? ` (extra ${extra.join(", ")})` : ""}.`;
      } else if (source.length) {
        actionNote = " Root actions match the source decision.";
      }
    } catch (error) {
      actionNote = ` Tree preview could not verify root actions (${
        error instanceof EngineError ? error.message : "preview failed"
      }).`;
    }
    const weights = {
      oop: parseRangeText(transferred.draft.oopRange),
      ip: parseRangeText(transferred.draft.ipRange),
    };
    rangeHistory.push(exactPairFromDraft(get().draft));
    set({
      draft: transferred.draft,
      weights,
      draftRevision: bumpRevision(get().draftRevision),
      setupMeta: transferred.meta,
      canUndoRange: rangeHistory.canUndo(),
      canRedoRange: rangeHistory.canRedo(),
      workspace: "build",
      message: `${transferred.warnings[0] ?? "Build spot ready."}${actionNote}`,
    });
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

  async ensureNodeAnalysis() {
    const solutionId = get().solutionId;
    const node = get().currentNode;
    if (!solutionId || !node || !isDecisionNodeForAnalysis(node)) {
      return;
    }
    const nodeId = node.node_id;
    // Server accepts both metrics under one selection identity (EV then equity).
    try {
      await engineClient.startNodeAnalysis(solutionId, nodeId, ["values", "equity"]);
    } catch {
      // Fall through to per-metric paths; they still enqueue safely.
    }
    // Action EV ahead of equity — cheaper on measured spots; both stay independently
    // observable and the worker queue now keeps the slot until each settles.
    void get().calculateEv();
    void get().loadEquity();
  },

  async calculateEv() {
    const solutionId = get().solutionId;
    const node = get().currentNode;
    if (!solutionId || !node) {
      return;
    }
    if (!isDecisionNodeForAnalysis(node)) {
      return;
    }
    const revision = analysisRevision(node, get().status);
    const nodeId = node.node_id;
    if (analysisIsReadyForNode(get().nodeValues, solutionId, nodeId)) {
      return;
    }
    const cached = getAnalysisPageCache().get<ActionValuesPayload>({
      solutionId,
      nodeId,
      revision,
      kind: "values",
    });
    if (cached) {
      set({
        nodeValues: cached,
        phase: phaseFromStatus(get().status, "complete"),
        message: "Action EVs ready.",
        matrixMode: get().matrixMode === "strategy" ? "strategy-ev" : get().matrixMode,
      });
      return;
    }
    const liveValues = get().nodeValues;
    if (
      liveValues?.pending &&
      liveValues.node_id === nodeId &&
      liveValues.solution_id === solutionId
    ) {
      return;
    }
    if (
      analysisErrorIsPermanent(liveValues?.error) &&
      liveValues?.node_id === nodeId &&
      liveValues?.solution_id === solutionId
    ) {
      return;
    }
    set({
      phase: "analysis_pending",
      message: "Calculating action EVs…",
      nodeValues: { pending: true, node_id: nodeId, solution_id: solutionId },
    });
    enqueueWorkerAnalysis({
      kind: "values",
      solutionId,
      nodeId,
      revision,
      priority: "auto",
      run: async () => {
        const liveNode = get().currentNode;
        const liveSolution = get().solutionId;
        if (
          !liveNode ||
          liveNode.node_id !== nodeId ||
          liveSolution !== solutionId
        ) {
          return;
        }
        const { token, identity } = beginAnalysisRequest(
          "values",
          solutionId,
          nodeId,
          revision,
        );
        await pollAnalysis(
          "values",
          token,
          () => engineClient.getValues(solutionId, nodeId),
          (values) => {
            if (!analysisRequestIsCurrent("values", token)) {
              return;
            }
            const live = get().currentNode;
            if (
              !live ||
              live.node_id !== identity.nodeId ||
              get().solutionId !== identity.solutionId
            ) {
              getAnalysisPageCache().set(
                { solutionId, nodeId, revision, kind: "values" },
                values,
              );
              return;
            }
            if (values.node_id && values.node_id !== identity.nodeId) {
              return;
            }
            getAnalysisPageCache().set(
              { solutionId, nodeId, revision, kind: "values" },
              values,
            );
            set({
              nodeValues: values,
              phase: phaseFromStatus(get().status, "complete"),
              message: "Action EVs ready.",
              matrixMode:
                get().matrixMode === "strategy" ? "strategy-ev" : get().matrixMode,
            });
            prefetchChildValues(solutionId, live, revision);
          },
          (message) => {
            if (!analysisRequestIsCurrent("values", token)) {
              return;
            }
            // Keep a settled failure payload so overlay auto-load does not retry-loop.
            set({
              phase: phaseFromStatus(get().status, "complete"),
              message,
              nodeValues: {
                pending: false,
                error: message,
                node_id: identity.nodeId,
                solution_id: identity.solutionId,
              },
            });
          },
        );
      },
    });
  },

  async loadEquity() {
    const solutionId = get().solutionId;
    const node = get().currentNode;
    if (!solutionId || !node) {
      return;
    }
    const revision = analysisRevision(node, get().status);
    const nodeId = node.node_id;
    const liveEquity = get().equity as {
      pending?: boolean;
      node_id?: string;
      solution_id?: string;
      error?: string;
    } | null;
    if (analysisIsReadyForNode(liveEquity, solutionId, nodeId)) {
      return;
    }
    const cached = getAnalysisPageCache().get({
      solutionId,
      nodeId,
      revision,
      kind: "equity",
    });
    if (cached) {
      set({ equity: cached, message: "Equity ready." });
      return;
    }
    if (
      liveEquity?.pending &&
      liveEquity.node_id === nodeId &&
      liveEquity.solution_id === solutionId
    ) {
      return;
    }
    if (
      analysisErrorIsPermanent(liveEquity?.error) &&
      liveEquity?.node_id === nodeId &&
      liveEquity?.solution_id === solutionId
    ) {
      return;
    }
    set({
      message: "Loading equity…",
      // Keep the current analysis tab — matrix overlay auto-load must not steal focus.
      equity: { pending: true, node_id: nodeId, solution_id: solutionId },
    });
    enqueueWorkerAnalysis({
      kind: "equity",
      solutionId,
      nodeId,
      revision,
      priority: "auto",
      run: async () => {
        if (
          get().currentNode?.node_id !== nodeId ||
          get().solutionId !== solutionId
        ) {
          return;
        }
        const { token, identity } = beginAnalysisRequest(
          "equity",
          solutionId,
          nodeId,
          revision,
        );
        await pollAnalysis(
          "equity",
          token,
          () =>
            engineClient.getEquity(solutionId, nodeId) as Promise<{
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
              getAnalysisPageCache().set(
                { solutionId, nodeId, revision, kind: "equity" },
                equity,
              );
              return;
            }
            if (equity.node_id && equity.node_id !== identity.nodeId) {
              return;
            }
            getAnalysisPageCache().set(
              { solutionId, nodeId, revision, kind: "equity" },
              equity,
            );
            set({ equity, message: "Equity ready." });
          },
          (message) => {
            if (!analysisRequestIsCurrent("equity", token)) {
              return;
            }
            // Keep a settled failure payload so overlay auto-load does not retry-loop.
            set({
              message,
              equity: {
                pending: false,
                error: message,
                node_id: identity.nodeId,
                solution_id: identity.solutionId,
              },
            });
          },
        );
      },
    });
  },

  async loadCategories() {
    const unavailable = rejectUnavailableIpcFeature("categories");
    if (unavailable) {
      set({ message: unavailable });
      return;
    }
    const solutionId = get().solutionId;
    const node = get().currentNode;
    if (!solutionId || !node) {
      return;
    }
    const revision = analysisRevision(node, get().status);
    const nodeId = node.node_id;
    const cached = getAnalysisPageCache().get({
      solutionId,
      nodeId,
      revision,
      kind: "categories",
    });
    if (cached) {
      set({
        categories: cached,
        analysisTab: "categories",
        message: "Categories ready.",
      });
      return;
    }
    const { token, identity } = beginAnalysisRequest(
      "categories",
      solutionId,
      nodeId,
      revision,
    );
    set({
      message: "Loading categories…",
      analysisTab: "categories",
      categories: { pending: true, node_id: nodeId, solution_id: solutionId },
    });
    await pollAnalysis(
      "categories",
      token,
      () =>
        engineClient.getCategories(solutionId, nodeId) as Promise<{
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
          getAnalysisPageCache().set(
            { solutionId, nodeId, revision, kind: "categories" },
            categories,
          );
          return;
        }
        if (categories.node_id && categories.node_id !== identity.nodeId) {
          return;
        }
        getAnalysisPageCache().set(
          { solutionId, nodeId, revision, kind: "categories" },
          categories,
        );
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

  async saveSolution(path) {
    const solutionId = get().solutionId;
    const previous = get().draft.solutionPath;
    const target = (path ?? previous).trim();
    if (!solutionId || !target) {
      const error = "Set a solution path before saving.";
      set({ message: error });
      return { ok: false, error };
    }
    set({ phase: "saving", message: `Saving ${target}…` });
    // Open/Save run as explorer overlay jobs (202 + status). Keep polling so
    // the accept loop stays free for `/api/status` during the write.
    try {
      await engineClient.save(solutionId, target);
    } catch (error) {
      const message =
        error instanceof EngineError ? error.message : "Save failed";
      // Keep the previous displayed path on write failure.
      set({
        phase: phaseFromStatus(get().status, "complete"),
        message,
      });
      return { ok: false, error: message };
    }
    set({
      draft: { ...get().draft, solutionPath: target },
      lastCheckpointPath: target,
      phase: phaseFromStatus(get().status, "complete"),
      message: `Saved ${target}`,
    });
    return { ok: true, path: target };
  },

  async openSolution(path) {
    const target = (
      path ??
      lastValidCheckpointPath(get().draft.solutionPath, get().lastCheckpointPath)
    ).trim();
    if (!target) {
      const error = "Set a solution path before opening.";
      set({ message: error });
      return { ok: false, error };
    }
    // Stage: show loading only. Do not clear path, undo, or published study
    // until the engine open succeeds — failure must preserve the whole document.
    set({
      phase: "loading",
      message: `Opening ${target}…`,
    });
    // Open is accepted as 202; the client polls status until the file job
    // settles. Leave Study polling running so progress stays live.
    try {
      await engineClient.open(target);
    } catch (error) {
      const message =
        error instanceof EngineError ? error.message : "Open failed";
      // Document identity, draft path, undo stacks, and published study unchanged.
      set({
        phase: "failed",
        message,
      });
      void reportSolveFailedFault({
        reason: message,
        exitReason: "open-failed",
        lastOp: "open",
      });
      return { ok: false, error: message };
    }

    // Commit: open succeeded — reset histories and replace the visible document.
    invalidateLifecycleRequests();
    dropAnalysisCaches();
    pendingReloadNodeId = null; // opened checkpoint lands at root
    setupHistoryPast.length = 0;
    rangeHistory.clear();
    set({
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
      lastCheckpointPath: target,
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
    return { ok: true, path: target };
  },

  async loadCompare(nodeId) {
    const unavailable = rejectUnavailableIpcFeature("compare");
    if (unavailable) {
      set({ compareNote: null, message: unavailable });
      return;
    }
    const baseline = get().baselineSolutionId;
    const scenario = get().solutionId;
    const targetNode = nodeId || get().currentNode?.node_id;
    const requestScope = captureCompareRequestScope({
      baselineId: baseline,
      scenarioId: scenario,
      nodeId: targetNode,
    });
    if (!requestScope) {
      set({
        compareNote: null,
        message:
          "Compare needs a baseline (after resolve-locked), the scenario solution, and a decision node.",
      });
      return;
    }
    try {
      const compareNote = (await engineClient.compare(
        requestScope.baselineId,
        requestScope.scenarioId,
        requestScope.nodeId,
      )) as ComparePayload;
      // Payload must match the request AND live study identity must still match.
      // Otherwise a late response can steal the workspace into Compare.
      const liveStillCurrent = compareRequestIsCurrent(requestScope, {
        baselineId: get().baselineSolutionId,
        scenarioId: get().solutionId,
        nodeId: get().currentNode?.node_id,
      });
      if (
        !compareNoteIsValid(
          compareNote,
          requestScope.baselineId,
          requestScope.scenarioId,
          requestScope.nodeId,
        ) ||
        !liveStillCurrent
      ) {
        if (!liveStillCurrent) {
          // Superseded — discard silently rather than clobbering the new context.
          return;
        }
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
        message: `Compare ${requestScope.baselineId} → ${requestScope.scenarioId}: EV Δ ${Number(compareNote.value_delta).toFixed(4)}`,
      });
    } catch (error) {
      if (
        !compareRequestIsCurrent(requestScope, {
          baselineId: get().baselineSolutionId,
          scenarioId: get().solutionId,
          nodeId: get().currentNode?.node_id,
        })
      ) {
        return;
      }
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
      // Library catalogue failures must not paint "Engine unreachable" over a
      // healthy solver-engine IPC session (post-#286 Zig-only packaging).
      const detail =
        error instanceof EngineError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Failed to load recent solutions";
      set({
        libraryLists: { ...get().libraryLists, recent: [], loading: false },
        message: `Library recent list unavailable: ${detail}`,
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
      const detail =
        error instanceof EngineError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Failed to load templates";
      set({
        libraryLists: { ...get().libraryLists, templates: [], loading: false },
        message: `Library templates unavailable: ${detail}`,
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
      const detail =
        error instanceof EngineError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Failed to load range presets";
      set({
        libraryLists: { ...get().libraryLists, ranges: [], loading: false },
        message: `Library ranges unavailable: ${detail}`,
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
      const state = get();
      // Full template = complete setup transaction (no partial merge).
      // Absent utility fields reset; explicit zeros (rake-rate 0) are preserved.
      const next = draftFromFullTemplate(parsed, {
        solutionPath: state.draft.solutionPath,
        preserveSolveSession: {
          iterations: state.draft.iterations,
          algorithm: state.draft.algorithm,
          samples: state.draft.samples,
          accuracy: state.draft.accuracy,
          frozen: state.draft.frozen,
        },
      });
      const weights = {
        oop: parseRangeText(next.oopRange),
        ip: parseRangeText(next.ipRange),
      };
      rangeHistory.push(exactPairFromDraft(state.draft));
      set({
        draft: next,
        weights,
        draftRevision: bumpRevision(state.draftRevision),
        setupMeta: null,
        canUndoSetup: setupHistoryPast.length > 0,
        canUndoRange: rangeHistory.canUndo(),
        canRedoRange: rangeHistory.canRedo(),
        message: `Loaded template ${trimmed} (${
          typeof parsed.kind === "string" ? parsed.kind : "configuration"
        }) into Build draft.`,
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
