import type { StudySetupPreferences } from "../setup";
import type { SpotDraft } from "../types";
import type { RangeProfileCatalogue } from "../profiles";
import { buildUnifiedAssistantSystemPrompt } from "./contextPacks";
import { createFakeHelpChatClient } from "../help/helpChat";
import {
  ASSISTANT_MAX_TEXT_LENGTH,
  AssistantProviderError,
  type AssistantProvider,
  type InterpretProposal,
  type InterpretRequest,
  type ProfileMeta,
} from "./provider";
import {
  OPENAI_ASSISTANT_DEFAULT_MODEL,
  OPENAI_CHAT_COMPLETIONS_URL,
  parseInterpretProposal,
} from "./openaiProvider";
import { createFakeAssistantProvider } from "./fakeProvider";
import {
  createAssistantSession,
  type AssistantRunResult,
} from "./workflow";
import type { CatalogueLike } from "./resolve";

const ANSWER_TOOL = "answer_user";
const SETUP_TOOL = "emit_study_setup_proposal";

export type UnifiedChatMode = "fake" | "openai";

export interface UnifiedChatRequest {
  text: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  setupSummary: string;
  preferencesSummary?: string;
  availableProfiles: ProfileMeta[];
  capabilities?: string[];
  draftRevision: number;
  signal?: AbortSignal;
}

export type UnifiedChatOutcome =
  | {
      kind: "answer";
      message: string;
      provider: UnifiedChatMode;
    }
  | {
      kind: "setup";
      message: string;
      provider: UnifiedChatMode;
      proposal: InterpretProposal;
      /** Present after local resolve when kind is a draft-producing proposal. */
      run?: AssistantRunResult;
    };

export interface UnifiedChatDeps {
  catalogue: RangeProfileCatalogue | CatalogueLike;
  getDraft: () => SpotDraft;
  getRevision: () => number;
  preferences: StudySetupPreferences;
}

export interface UnifiedChatClient {
  turn(request: UnifiedChatRequest, deps: UnifiedChatDeps): Promise<UnifiedChatOutcome>;
}

export interface OpenAiUnifiedChatOptions {
  getCredential: () => Promise<string | null>;
  model?: string;
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

/** Heuristic: likely a Build mutation vs a product question. */
export function looksLikeSetupRequest(text: string): boolean {
  const lower = text.trim().toLowerCase();
  if (!lower) return false;
  if (
    /^(how|what|where|why|when|who|which|can i|do i|does|is there|explain|tell me)\b/.test(
      lower,
    ) &&
    !/\b(set up|setup|prepare|change the|duplicate|use \d|board to|flop to)\b/.test(lower)
  ) {
    return false;
  }
  return (
    /\b(set up|setup|prepare|duplicate|change the (board|flop|turn|river)|board to|flop to|use \d|bet size|calling range|opening range|vs bb|vs btn|vs co|srp|3bet|3bp|4bp|100nl|generate (a )?range|interpolate)\b/i.test(
      lower,
    ) || /\b(oop|ip)\b.*\brange\b/i.test(lower)
  );
}

function summarizeProposal(proposal: InterpretProposal): string {
  if (proposal.kind === "clarify") {
    return proposal.questions.join(" ");
  }
  if (proposal.kind === "unsupported" || proposal.kind === "unrelated") {
    return proposal.message;
  }
  const bits = [`Proposed ${proposal.kind.replace(/_/g, " ")}`];
  if (proposal.selectedProfileId) bits.push(`profile ${proposal.selectedProfileId}`);
  if (proposal.board) bits.push(`board ${proposal.board}`);
  if (proposal.stackBb != null) bits.push(`${proposal.stackBb}bb`);
  if (proposal.stakesLabel) bits.push(proposal.stakesLabel);
  if (proposal.generatedRanges) bits.push("with model-generated ranges");
  if (proposal.interpolateFromIds) bits.push("with stack interpolation");
  bits.push("Review and Apply to update Build — Solve stays separate.");
  return bits.join(" · ");
}

/**
 * Demo unified client: routes setup-like text through the fake setup provider +
 * session resolve; otherwise uses the fake help client.
 */
export class FakeUnifiedChatClient implements UnifiedChatClient {
  private readonly setupProvider: AssistantProvider = createFakeAssistantProvider();
  private readonly session = createAssistantSession();

  async turn(
    request: UnifiedChatRequest,
    deps: UnifiedChatDeps,
  ): Promise<UnifiedChatOutcome> {
    const text = request.text.trim();
    if (!text) {
      return {
        kind: "answer",
        provider: "fake",
        message: "Ask a product question or describe a study to prepare.",
      };
    }

    if (!looksLikeSetupRequest(text)) {
      const help = createFakeHelpChatClient();
      const reply = await help.ask({ question: text, history: request.history });
      return { kind: "answer", provider: "fake", message: reply.message };
    }

    const run = await this.session.run(text, {
      provider: this.setupProvider,
      catalogue: deps.catalogue,
      getDraft: deps.getDraft,
      getRevision: deps.getRevision,
      preferences: deps.preferences,
      signal: request.signal,
      setupSummary: request.setupSummary,
      preferencesSummary: request.preferencesSummary,
      availableProfiles: request.availableProfiles,
      capabilities: request.capabilities,
    });

    if (run.status === "error") {
      throw run.error ?? new AssistantProviderError("invalid_response", run.message ?? "Failed");
    }
    if (run.status === "cancelled") {
      throw new AssistantProviderError("aborted", "Cancelled");
    }
    if (run.proposal) {
      return {
        kind: "setup",
        provider: "fake",
        proposal: run.proposal,
        run,
        message: run.message ?? summarizeProposal(run.proposal),
      };
    }
    return {
      kind: "answer",
      provider: "fake",
      message: run.message ?? "Done",
    };
  }
}

/**
 * OpenAI unified client: model chooses answer_user vs emit_study_setup_proposal.
 * Setup tool args are resolved through the same assistant session as Build.
 */
export class OpenAiUnifiedChatClient implements UnifiedChatClient {
  private readonly getCredential: () => Promise<string | null>;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;
  private readonly session = createAssistantSession();

  constructor(options: OpenAiUnifiedChatOptions) {
    this.getCredential = options.getCredential;
    this.model = options.model ?? OPENAI_ASSISTANT_DEFAULT_MODEL;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.endpoint = options.endpoint ?? OPENAI_CHAT_COMPLETIONS_URL;
  }

  async turn(
    request: UnifiedChatRequest,
    deps: UnifiedChatDeps,
  ): Promise<UnifiedChatOutcome> {
    const text = request.text.trim();
    if (!text) {
      throw new AssistantProviderError("invalid_response", "Empty assistant request");
    }
    if (text.length > ASSISTANT_MAX_TEXT_LENGTH) {
      throw new AssistantProviderError(
        "text_too_long",
        `Request text exceeds ${ASSISTANT_MAX_TEXT_LENGTH} characters`,
      );
    }

    const credential = await this.getCredential();
    if (!credential) {
      throw new AssistantProviderError(
        "missing_credential",
        "No OpenAI credential available for the Study assistant",
      );
    }

    const history = (request.history ?? []).slice(-10);
    const userPayload = JSON.stringify({
      text: text.slice(0, ASSISTANT_MAX_TEXT_LENGTH),
      setupSummary: request.setupSummary,
      preferencesSummary: request.preferencesSummary,
      draftRevision: request.draftRevision,
      availableProfiles: request.availableProfiles,
      capabilities: request.capabilities,
    });

    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: buildUnifiedAssistantSystemPrompt() },
      ...history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content.slice(0, ASSISTANT_MAX_TEXT_LENGTH),
      })),
      { role: "user", content: userPayload },
    ];

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${credential}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          messages,
          tools: [
            {
              type: "function",
              function: {
                name: ANSWER_TOOL,
                description:
                  "Answer a product/help question without changing the Build draft.",
                parameters: {
                  type: "object",
                  additionalProperties: false,
                  required: ["message"],
                  properties: {
                    message: { type: "string" },
                  },
                },
              },
            },
            {
              type: "function",
              function: {
                name: SETUP_TOOL,
                description:
                  "Emit a structured study-setup proposal. Never include range weight strings except in generatedRanges.",
                parameters: {
                  type: "object",
                  additionalProperties: true,
                  required: ["kind"],
                  properties: {
                    kind: { type: "string" },
                  },
                },
              },
            },
          ],
          tool_choice: "auto",
        }),
        signal: request.signal,
      });
    } catch (err) {
      if (request.signal?.aborted) {
        throw new AssistantProviderError("aborted", "Cancelled");
      }
      const message = err instanceof Error ? err.message : "Network request failed";
      throw new AssistantProviderError("network", message);
    }

    if (!response.ok) {
      throw new AssistantProviderError(
        "network",
        `OpenAI request failed with HTTP ${response.status}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AssistantProviderError(
        "invalid_response",
        "OpenAI response was not valid JSON",
      );
    }

    const tool = extractToolCall(payload);

    if (tool.name === ANSWER_TOOL) {
      const message =
        typeof tool.args.message === "string" && tool.args.message.trim()
          ? tool.args.message.trim()
          : "I could not form an answer.";
      return { kind: "answer", provider: "openai", message };
    }

    if (tool.name === SETUP_TOOL) {
      const proposal = parseInterpretProposal(tool.args);
      // Re-resolve through the session so catalogue / generate / interpolate stay app-side.
      const bridgingProvider: AssistantProvider = {
        interpret: async (_req: InterpretRequest) => proposal,
      };
      const run = await this.session.run(text, {
        provider: bridgingProvider,
        catalogue: deps.catalogue,
        getDraft: deps.getDraft,
        getRevision: deps.getRevision,
        preferences: deps.preferences,
        signal: request.signal,
        setupSummary: request.setupSummary,
        preferencesSummary: request.preferencesSummary,
        availableProfiles: request.availableProfiles,
        capabilities: request.capabilities,
      });
      if (run.status === "error") {
        throw run.error ?? new AssistantProviderError("invalid_response", run.message ?? "Failed");
      }
      if (run.status === "cancelled") {
        throw new AssistantProviderError("aborted", "Cancelled");
      }
      return {
        kind: "setup",
        provider: "openai",
        proposal: run.proposal ?? proposal,
        run,
        message: run.message ?? summarizeProposal(run.proposal ?? proposal),
      };
    }

    // Fallback: treat plain text content as an answer.
    const content = extractPlainContent(payload);
    if (content) {
      return { kind: "answer", provider: "openai", message: content };
    }

    throw new AssistantProviderError(
      "invalid_response",
      `Unexpected tool: ${tool.name}`,
    );
  }
}

function extractToolCall(payload: unknown): {
  name: string;
  args: Record<string, unknown>;
} {
  if (!payload || typeof payload !== "object") {
    throw new AssistantProviderError(
      "invalid_response",
      "OpenAI payload missing object body",
    );
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new AssistantProviderError(
      "invalid_response",
      "OpenAI payload missing choices",
    );
  }
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== "object") {
    throw new AssistantProviderError(
      "invalid_response",
      "OpenAI payload missing message",
    );
  }
  const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    // Allow plain-text fallback by returning a sentinel; caller checks content.
    return { name: "", args: {} };
  }
  const fn = (toolCalls[0] as { function?: { name?: unknown; arguments?: unknown } })
    .function;
  const name = typeof fn?.name === "string" ? fn.name : "";
  const rawArgs = fn?.arguments;
  if (typeof rawArgs !== "string") {
    throw new AssistantProviderError(
      "invalid_response",
      "OpenAI tool call missing arguments string",
    );
  }
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(rawArgs) as Record<string, unknown>;
  } catch {
    throw new AssistantProviderError(
      "invalid_response",
      "OpenAI tool arguments were not valid JSON",
    );
  }
  return { name, args };
}

function extractPlainContent(payload: unknown): string | null {
  try {
    const choices = (payload as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || !choices[0]) return null;
    const message = (choices[0] as { message?: { content?: unknown } }).message;
    if (typeof message?.content === "string" && message.content.trim()) {
      return message.content.trim();
    }
  } catch {
    return null;
  }
  return null;
}

export function createFakeUnifiedChatClient(): FakeUnifiedChatClient {
  return new FakeUnifiedChatClient();
}

export function createOpenAiUnifiedChatClient(
  options: OpenAiUnifiedChatOptions,
): OpenAiUnifiedChatClient {
  return new OpenAiUnifiedChatClient(options);
}
