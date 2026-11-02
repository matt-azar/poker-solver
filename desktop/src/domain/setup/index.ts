export type {
  PotType,
  PreflopAction,
  PreflopActionKind,
  PreflopSizeMeaning,
  SetupConflict,
  SetupDraftFields,
  SetupDraftResult,
  SetupFieldProvenance,
  SetupMissing,
  SetupMode,
  SetupPatch,
  SetupProfileRef,
  SetupValidationResult,
  StudySetupIntent,
  StudySetupTreePreset,
} from "./types";

export {
  DEFAULT_RAKE_ENVIRONMENT,
  DEFAULT_STARTING_STACK_BB,
  assignSrpSeats,
  derivePostflopPotAndStacks,
  inferSizeMeaning,
  parseStakesLabelStackBb,
  potTypeFromActions,
  profileActionsToSetupActions,
  resolveStartingStackBb,
  seatsForCoVsBbSrp,
  stakesLabelImpliesStack,
  type BlindStructure,
  type DerivePostflopInput,
  type DerivePostflopResult,
  type PostflopSeatAssignment,
} from "./derive";

export {
  assertRevision,
  createBlankSetupDraft,
  isStaleProposal,
  mergeSetupPatch,
  validateSetupForSolve,
} from "./apply";

export {
  STUDY_SETUP_PREFS_KEY,
  browserLocalStorageAdapter,
  clearStudySetupPreferences,
  emptyStudySetupPreferences,
  loadStudySetupPreferences,
  normalizeStudySetupPreferences,
  saveStudySetupPreferences,
  type StorageAdapter,
  type StudySetupPreferences,
} from "./preferences";

export {
  bumpRevision,
  initialRevision,
  nextRevision,
  revisionsEqual,
} from "./revision";

export {
  EMPTY_SETUP_META,
  applySetupTransaction,
  metaFromSetupResult,
  undoSetupTransactionGuarded,
  type ApplySetupTransactionResult,
  type SetupStudyMeta,
  type SetupTransactionSnapshot,
  type SetupUndoEntry,
  type UndoSetupTransactionResult,
} from "./setupTransaction";

export {
  actionsSignature,
  analysisIdentitiesEqual,
  analysisIdentityKey,
  analysisPayloadMatchesNode,
  combosSignature,
  compareNoteIsValid,
  draftFromOpenedSolution,
  draftPartialFromSolutionConfig,
  draftPartialFromStatus,
  openDraftBase,
  resolveBaselineSolutionId,
  shouldClearCompareNote,
  strategyEditScopeFromNode,
  strategyEditScopesEqual,
  type AnalysisIdentity,
  type AnalysisKind,
  type OpenedSolutionDraftResult,
  type StrategyEditScope,
} from "./identity";
