export {
  ASSISTANT_MAX_TEXT_LENGTH,
  AssistantProviderError,
  DEFAULT_ASSISTANT_CAPABILITIES,
  profileToMeta,
  type AssistantProvider,
  type AssistantProviderErrorCode,
  type InterpretProposal,
  type InterpretRequest,
  type ProfileMeta,
} from "./provider";

export {
  ASSISTANT_CONTEXT_SNAPSHOT_VERSION,
  SELECTED_HAND_ANALYSIS_TOOL_SCHEMA,
  STUDY_NODE_EVIDENCE_TOOL_NAMES,
  buildAssistantContextSnapshot,
  formatContextIndicator,
  summarizeContextSnapshot,
  type AssistantContextSnapshot,
  type BuildAssistantContextSnapshotInput,
} from "./contextSnapshot";

export {
  ASSISTANT_COMPARE_RUNOUTS_LIMITS,
  ASSISTANT_EVIDENCE_LIMITS,
  COMPARE_RUNOUTS_TOOL,
  LIST_BLUFF_CANDIDATES_TOOL,
  QUERY_NODE_STRATEGY_TOOL,
  QUERY_SELECTED_HAND_TOOL,
  STUDY_EVIDENCE_DEFERRED_TOOLS,
  STUDY_EVIDENCE_TOOL_SCHEMAS,
  compareRunouts,
  executeStudyEvidenceTool,
  findSeatDecisionNodeId,
  isStudyEvidenceToolName,
  listBluffCandidates,
  looksLikeCompareRunoutsRequest,
  looksLikeStudyEvidenceRequest,
  queryNodeStrategy,
  querySelectedHandAnalysis,
  type BluffCandidatesEvidence,
  type CompareRunoutsEvidence,
  type NodeStrategyEvidence,
  type SelectedHandEvidence,
  type StudyEvidenceHost,
  type StudyEvidenceLiveState,
  type StudyEvidenceSeat,
} from "./studyEvidence";

export {
  buildApplicationReceipt,
  chatContentFromReceipt,
  fieldLabel,
  renderPendingSetupReview,
  renderReceiptChatText,
  renderReceiptReviewCard,
  setupResultHasApplyablePatch,
  setupResultIsBroad,
  type ApplicationReceipt,
  type ApplicationReceiptFieldChange,
} from "./applicationReceipt";

export {
  FakeAssistantProvider,
  createFakeAssistantProvider,
} from "./fakeProvider";

export {
  OPENAI_ASSISTANT_DEFAULT_MODEL,
  OPENAI_CHAT_COMPLETIONS_URL,
  OpenAiAssistantProvider,
  createOpenAiAssistantProvider,
  parseInterpretProposal,
  type OpenAiAssistantProviderOptions,
} from "./openaiProvider";

export {
  buildHelpSystemPrompt,
  buildSetupAssistantSystemPrompt,
  buildUnifiedAssistantSystemPrompt,
  loadAssistantContextPack,
  type AssistantContextKind,
} from "./contextPacks";

export {
  ASSISTANT_EVIDENCE_TOOL_MAX_ROUNDS,
  FakeUnifiedChatClient,
  OpenAiUnifiedChatClient,
  createFakeUnifiedChatClient,
  createOpenAiUnifiedChatClient,
  looksLikeSetupRequest,
  summarizeProposal,
  type UnifiedChatClient,
  type UnifiedChatDeps,
  type UnifiedChatMode,
  type UnifiedChatOutcome,
  type UnifiedChatRequest,
  type OpenAiUnifiedChatOptions,
} from "./unifiedChat";

export {
  catalogueProfileMetas,
  prepareStudyFromProfile,
  resolveAssistantProposal,
  type CatalogueLike,
  type ResolveAssistantProposalArgs,
} from "./resolve";

export {
  createAssistantSession,
  type AssistantRunContext,
  type AssistantRunResult,
  type AssistantRunStatus,
  type AssistantSession,
} from "./workflow";

export {
  LIVE_EVAL_CASES,
  LIVE_EVAL_PROFILE_IDS,
  scoreLiveEvalCase,
  summarizeLiveEval,
  type CaseScore,
  type FieldScore,
  type LiveEvalCase,
  type LiveEvalExpect,
  type LiveEvalSummary,
} from "./liveEvalCases";

export {
  GENERATED_RANGE_MAX_CHARS,
  validateGeneratedRanges,
  type GeneratedRangesPayload,
  type GeneratedRangesValidation,
} from "./generatedRanges";

export type { GeneratedRangesProposal } from "./provider";

export {
  FakeHelpChatClient,
  OpenAiHelpChatClient,
  createFakeHelpChatClient,
  createOpenAiHelpChatClient,
  type HelpChatClient,
  type HelpChatMessage,
  type HelpChatReply,
  type HelpChatRequest,
  type HelpChatRole,
  type OpenAiHelpChatOptions,
} from "./help";

export {
  commitAssistantSetup,
  type AssistantSetupApplyFn,
  type AssistantSetupApplyOutcome,
} from "./commitAssistantSetup";

