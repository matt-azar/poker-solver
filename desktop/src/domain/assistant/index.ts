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
  buildAssistantContextSnapshot,
  formatContextIndicator,
  summarizeContextSnapshot,
  type AssistantContextSnapshot,
  type BuildAssistantContextSnapshotInput,
} from "./contextSnapshot";

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

