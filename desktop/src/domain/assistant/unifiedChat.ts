import type { StudySetupPreferences } from "../setup";
import type { SpotDraft } from "../types";
import type { RangeProfileCatalogue } from "../profiles";
import { buildUnifiedAssistantSystemPrompt } from "./contextPacks";
import {
  SELECTED_HAND_ANALYSIS_TOOL_SCHEMA,
  STUDY_NODE_EVIDENCE_TOOL_NAMES,
  type AssistantContextSnapshot,
} from "./contextSnapshot";
import { createFakeHelpChatClient } from "./help/helpChat";
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
import {
  COMPARE_RUNOUTS_TOOL,
  executeStudyEvidenceTool,
  isStudyEvidenceToolName,
  LIST_BLUFF_CANDIDATES_TOOL,
  looksLikeCompareRunoutsRequest,
  looksLikeStudyEvidenceRequest,
  QUERY_NODE_STRATEGY_TOOL,
  QUERY_SELECTED_HAND_TOOL,
  STUDY_EVIDENCE_DEFERRED_TOOLS,
  STUDY_EVIDENCE_TOOL_SCHEMAS,
  type BluffCandidatesEvidence,
  type CompareRunoutsEvidence,
  type NodeStrategyEvidence,
  type StudyEvidenceHost,
} from "./studyEvidence";

const ANSWER_TOOL = "answer_user";
const SETUP_TOOL = "emit_study_setup_proposal";

/** Max evidence tool rounds before the model must answer or set up. */
export const ASSISTANT_EVIDENCE_TOOL_MAX_ROUNDS = 3;

export type UnifiedChatMode = "fake" | "openai";

export interface UnifiedChatRequest {
  text: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  setupSummary: string;
  preferencesSummary?: string;
  availableProfiles: ProfileMeta[];
  capabilities?: string[];
  draftRevision: number;
  /** Versioned Build / Study context; preferred over ad-hoc setupSummary alone. */
  contextSnapshot?: AssistantContextSnapshot;
  signal?: AbortSignal;
}

export type UnifiedChatOpenInStudy = {
  card: string;
  resolvedNodeId: string;
  line?: string | null;
};

export type UnifiedChatOutcome =
  | {
      kind: "answer";
      message: string;
      provider: UnifiedChatMode;
      /** Optional Compare-runouts Open in Study target (same as manual cell click). */
      openInStudy?: UnifiedChatOpenInStudy;
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
  /** Optional host for bounded Study evidence tools (strategy / bluffs / hand). */
  evidenceHost?: StudyEvidenceHost;
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

type ChatMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | {
      role: "assistant";
      content?: string | null;
      tool_calls: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

/** Explicit request to mutate Build vs product/Study Q&A vs ambiguous wording. */
export type AssistantTurnIntent = "setup" | "qa" | "clarify";

const HELP_QUESTION_START =
  /^(how|what|where|why|when|who|which|can i|do i|does|is there|explain|tell me)\b/;

const EXPLICIT_MUTATION_VERB =
  /\b(set up|setup|prepare|duplicate|change|update|set|use|make|add|apply|generate|interpolate)\b/;

const DRAFT_FIELD_MUTATION =
  /\b(set|change|update|use|make)\b[\s\S]{0,48}\b(the\s+)?(pot|stack|iterations|iters|accuracy|time limit|threads|memory|samples|algorithm|max raises|board|flop|turn|river|range|ranges)\b/i;

const NUMERIC_FIELD_ASSIGNMENT =
  /\b(pot|stack|iterations|iters|accuracy|threads|memory|samples|max raises)\s*(to|=|:)?\s*\d/i;

const EXPLICIT_SETUP_COMMAND =
  /\b(set up|setup|prepare|duplicate)\b.+\b(study|spot|setup|board|range|ranges|srp|3bet|3bp|4bp|co|btn|bb|sb|utg|mp|hj|\d+\s*bb)\b|\b(change the (board|flop|turn|river)|board to|flop to)\b|\b(generate (a )?range|interpolate)\b/i;

/**
 * Classify whether the player wants a Build write, product/Study Q&A, or a
 * short clarification. Poker terms (3BP, 100NL, bet size) alone never imply
 * mutation; "How do I set up…" is help; "Can you set the stack to 150?" is setup.
 */
export function classifyAssistantTurnIntent(text: string): AssistantTurnIntent {
  const lower = text.trim().toLowerCase();
  if (!lower) return "qa";

  // "Can you set/change…" is an explicit edit request (not a how-to).
  if (/^can you\b/.test(lower) && EXPLICIT_MUTATION_VERB.test(lower)) {
    return "setup";
  }

  // Help / question framing stays on the Q&A path even when "set up" appears.
  if (HELP_QUESTION_START.test(lower)) {
    return "qa";
  }

  // Imperative / clear mutation commands.
  if (
    EXPLICIT_SETUP_COMMAND.test(lower) ||
    DRAFT_FIELD_MUTATION.test(lower) ||
    NUMERIC_FIELD_ASSIGNMENT.test(lower)
  ) {
    return "setup";
  }

  // Mutation-ish verbs without a clear imperative or help frame.
  if (
    EXPLICIT_MUTATION_VERB.test(lower) &&
    /\b(board|flop|range|ranges|stack|pot|study|spot|setup|set up)\b/.test(lower)
  ) {
    return "clarify";
  }

  return "qa";
}

/** True only for explicit Build-mutation requests (not help questions). */
export function looksLikeSetupRequest(text: string): boolean {
  return classifyAssistantTurnIntent(text) === "setup";
}

const CLARIFY_MUTATION_MESSAGE =
  "Do you want me to change the Build draft, or explain how to do it in the app?";

/**
 * Serialize Study evidence for the model. Shrink bluff/strategy row payloads
 * before JSON so the result stays valid within ASSISTANT_MAX_TEXT_LENGTH.
 */
export function serializeEvidenceToolResult(
  result: unknown,
  maxLen = ASSISTANT_MAX_TEXT_LENGTH,
): string {
  const asObject =
    result && typeof result === "object"
      ? ({ ...(result as Record<string, unknown>) } as Record<string, unknown>)
      : result;

  const tryStringify = (value: unknown): string => JSON.stringify(value);

  let payload = asObject;
  let encoded = tryStringify(payload);
  if (encoded.length <= maxLen) {
    return encoded;
  }

  if (
    payload &&
    typeof payload === "object" &&
    Array.isArray((payload as { rows?: unknown }).rows)
  ) {
    const rows = [...((payload as { rows: unknown[] }).rows)];
    let lo = 0;
    let hi = rows.length;
    let best = 0;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const candidate = {
        ...(payload as Record<string, unknown>),
        rows: rows.slice(0, mid),
        truncated: true,
      };
      const text = tryStringify(candidate);
      if (text.length <= maxLen) {
        best = mid;
        payload = candidate;
        encoded = text;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (encoded.length <= maxLen) {
      if (best < rows.length && payload && typeof payload === "object") {
        (payload as { truncated?: boolean }).truncated = true;
      }
      return encoded;
    }
  }

  // Last resort: drop bulky arrays but keep identity / filters / absences.
  if (payload && typeof payload === "object") {
    const slim: Record<string, unknown> = {
      ...(payload as Record<string, unknown>),
    };
    if (Array.isArray(slim.rows)) {
      slim.rows = [];
      slim.truncated = true;
    }
    if (Array.isArray(slim.actions)) {
      slim.actions = [];
    }
    if (Array.isArray(slim.strategy)) {
      slim.strategy = null;
    }
    if (Array.isArray(slim.actionEv)) {
      slim.actionEv = null;
    }
    const absences = Array.isArray(slim.absences) ? [...slim.absences] : [];
    absences.push(
      "Evidence payload exceeded the assistant size budget; open the Study panel for the full list.",
    );
    slim.absences = absences;
    encoded = tryStringify(slim);
    if (encoded.length <= maxLen) {
      return encoded;
    }
  }

  return tryStringify({
    ok: false,
    absences: [
      "Evidence payload exceeded the assistant size budget; retry on the intended decision or open the Study panel.",
    ],
  }).slice(0, maxLen);
}

/**
 * Human summary of a model proposal BEFORE local commit.
 * Must not claim Build was updated — StudyAssistantWindow / receipts own that.
 */
export function summarizeProposal(proposal: InterpretProposal): string {
  if (proposal.kind === "clarify") {
    return proposal.questions.join(" ");
  }
  if (proposal.kind === "unsupported" || proposal.kind === "unrelated") {
    return proposal.message;
  }
  const bits = [`Prepared ${proposal.kind.replace(/_/g, " ")}`];
  if (proposal.selectedProfileId) bits.push(`profile ${proposal.selectedProfileId}`);
  if (proposal.board) bits.push(`board ${proposal.board}`);
  if (proposal.stackBb != null) bits.push(`${proposal.stackBb}bb`);
  if (proposal.stakesLabel) bits.push(proposal.stakesLabel);
  if (proposal.fieldEdits) {
    const keys = Object.keys(proposal.fieldEdits);
    if (keys.length > 0) bits.push(`fields ${keys.join(", ")}`);
  }
  if (proposal.generatedRanges) bits.push("with model-generated ranges");
  if (proposal.interpolateFromIds) bits.push("with stack interpolation");
  bits.push("Solve stays separate until you run it.");
  return bits.join(" · ");
}

function formatNodeStrategyAnswer(evidence: NodeStrategyEvidence): string {
  if (!evidence.ok) {
    return (
      evidence.absences.join(" ") ||
      "Strategy evidence is unavailable for that seat at the current Study node."
    );
  }
  const mix = evidence.actions
    .map((row) => `${row.action} ${(row.frequency * 100).toFixed(1)}%`)
    .join(", ");
  const nav = evidence.navigated
    ? ` (opened ${evidence.seat} node ${evidence.nodeId} after ${evidence.hops} hop${evidence.hops === 1 ? "" : "s"})`
    : "";
  return `${evidence.seat} strategy at ${evidence.line ?? evidence.nodeId}${nav}: ${mix}.`;
}

function formatBluffAnswer(evidence: BluffCandidatesEvidence): string {
  if (!evidence.ok || evidence.rows.length === 0) {
    return (
      evidence.absences.join(" ") ||
      "No bluff candidates matched the current filters for that seat."
    );
  }
  const lines = evidence.rows.map((row) => {
    const ev =
      row.ev == null || !Number.isFinite(row.ev) ? "EV n/a" : `EV ${row.ev.toFixed(2)}`;
    const eq = `eq ${(row.equity * 100).toFixed(1)}%`;
    const size = row.topBetAction ? ` · ${row.topBetAction}` : "";
    return `${row.combo}: bet ${(row.betFreq * 100).toFixed(1)}% · ${ev} · ${eq}${size}`;
  });
  const more = evidence.truncated ? " (truncated)" : "";
  const caveat = evidence.absences.length ? ` ${evidence.absences.join(" ")}` : "";
  const minBet =
    evidence.minBetFreq != null
      ? `, min bet ≥ ${(evidence.minBetFreq * 100).toFixed(0)}%`
      : "";
  const minReach =
    evidence.minReach != null ? `, min reach ≥ ${evidence.minReach}` : "";
  return (
    `${evidence.seat} bluff candidates at ${evidence.line ?? evidence.nodeId}` +
    ` (node equity < ${(evidence.equityThreshold * 100).toFixed(0)}%${minBet}${minReach})${more}:\n` +
    `${lines.join("\n")}${caveat}`
  );
}

function formatCompareRunoutsAnswer(evidence: CompareRunoutsEvidence): string {
  const filterBits: string[] = [];
  if (evidence.filters.suits.length) {
    filterBits.push(`suits ${evidence.filters.suits.join(",")}`);
  }
  if (evidence.filters.ranks.length) {
    filterBits.push(`ranks ${evidence.filters.ranks.join(",")}`);
  }
  if (evidence.filters.excludeBoardPair) {
    filterBits.push("exclude board pairs");
  }
  if (evidence.filters.action) {
    filterBits.push(`rank by ${evidence.filters.action} frequency`);
  } else if (evidence.filters.sortBy === "deal") {
    filterBits.push("rank by deal probability");
  }
  const filterText = filterBits.length ? filterBits.join("; ") : "no card filter";
  if (!evidence.ok || evidence.rows.length === 0) {
    return (
      evidence.absences.join(" ") ||
      `No matching ${evidence.street ?? "runout"} cards on ${evidence.line ?? "this line"} (${filterText}).`
    );
  }
  const lines = evidence.rows.map((row) => {
    const freq =
      row.frequency == null || !Number.isFinite(row.frequency)
        ? "freq n/a"
        : `${(row.frequency * 100).toFixed(1)}%`;
    return `${row.card}: ${freq}`;
  });
  const more = evidence.truncated ? " (truncated)" : "";
  const opened = evidence.openedReport
    ? " Compare runouts is open with these filters."
    : "";
  const cardOpened = evidence.openedCard
    ? ` Opened ${evidence.openedCard} in Study.`
    : evidence.openInStudy
      ? ` Use Open in Study for ${evidence.openInStudy.card}, or click a highlighted card in the report.`
      : "";
  const caveat = evidence.absences.length ? ` ${evidence.absences.join(" ")}` : "";
  return (
    `${evidence.seat ?? "Seat"} ${evidence.street ?? "runout"}s on ${evidence.line ?? evidence.nodeId}` +
    ` (${filterText})${more}:${opened}\n${lines.join("\n")}${cardOpened}${caveat}`
  );
}

function inferEvidenceSeat(text: string): "IP" | "OOP" | undefined {
  if (/\bip\b/i.test(text) && !/\boop\b/i.test(text)) return "IP";
  if (/\boop\b/i.test(text) && !/\bip\b/i.test(text)) return "OOP";
  return undefined;
}

/** Best-effort structured args for the Fake client's compare_runouts path. */
export function inferCompareRunoutsArgs(text: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const seat = inferEvidenceSeat(text);
  if (seat) args.seat = seat;
  if (/\brivers?\b/i.test(text)) args.street = "river";
  else if (/\bturns?\b/i.test(text)) args.street = "turn";
  const suits: string[] = [];
  if (/\bhearts?\b/i.test(text)) suits.push("h");
  if (/\bspades?\b/i.test(text)) suits.push("s");
  if (/\bdiamonds?\b/i.test(text)) suits.push("d");
  if (/\bclubs?\b/i.test(text)) suits.push("c");
  if (suits.length) args.suits = suits;
  if (/\b(don'?t|do\s+not|doesn'?t)\s+pair\b/i.test(text)) {
    args.excludeBoardPair = true;
  }
  const size =
    text.match(/\b(\d{1,3}(?:\.\d+)?%)\s*(?:pot\s+)?bet\b/i) ||
    text.match(/\b(?:bet|ranked by)\s+(?:IP'?s?\s+|OOP'?s?\s+)?(\d{1,3}(?:\.\d+)?%?)\b/i) ||
    text.match(/\b(\d{1,3}(?:\.\d+)?%)\b/);
  if (size?.[1]) {
    args.action = size[1];
    args.sortBy = "frequency";
  }
  args.openReport = true;
  return args;
}

function openInStudyFromEvidence(
  toolName: string,
  result: unknown,
): UnifiedChatOpenInStudy | undefined {
  if (toolName !== COMPARE_RUNOUTS_TOOL.name) {
    return undefined;
  }
  const evidence = result as CompareRunoutsEvidence;
  if (!evidence?.openInStudy?.resolvedNodeId) {
    return undefined;
  }
  return {
    card: evidence.openInStudy.card,
    resolvedNodeId: evidence.openInStudy.resolvedNodeId,
    line: evidence.line,
  };
}

/**
 * Demo unified client: routes setup-like text through the fake setup provider +
 * session resolve; Study evidence questions through the evidence host when present;
 * otherwise uses the fake help client.
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

    // Freeze freshness before any async help/setup work.
    const requestRevision = request.draftRevision;
    const baseDraft = deps.getDraft();
    const intent = classifyAssistantTurnIntent(text);

    if (intent === "clarify") {
      return {
        kind: "answer",
        provider: "fake",
        message: CLARIFY_MUTATION_MESSAGE,
      };
    }

    if (intent !== "setup") {
      if (deps.evidenceHost && looksLikeStudyEvidenceRequest(text)) {
        const seat = inferEvidenceSeat(text);
        if (looksLikeCompareRunoutsRequest(text)) {
          const evidence = (await executeStudyEvidenceTool(
            deps.evidenceHost,
            COMPARE_RUNOUTS_TOOL.name,
            inferCompareRunoutsArgs(text),
          )) as CompareRunoutsEvidence;
          return {
            kind: "answer",
            provider: "fake",
            message: formatCompareRunoutsAnswer(evidence),
            openInStudy: openInStudyFromEvidence(
              COMPARE_RUNOUTS_TOOL.name,
              evidence,
            ),
          };
        }
        if (/\bbluffs?\b/i.test(text)) {
          const evidence = (await executeStudyEvidenceTool(
            deps.evidenceHost,
            LIST_BLUFF_CANDIDATES_TOOL.name,
            seat ? { seat } : {},
          )) as BluffCandidatesEvidence;
          return {
            kind: "answer",
            provider: "fake",
            message: formatBluffAnswer(evidence),
          };
        }
        if (/\b(strateg|frequenc|action\s+mix|how\s+often|what\s+does)\b/i.test(text)) {
          const evidence = (await executeStudyEvidenceTool(
            deps.evidenceHost,
            QUERY_NODE_STRATEGY_TOOL.name,
            seat ? { seat } : {},
          )) as NodeStrategyEvidence;
          return {
            kind: "answer",
            provider: "fake",
            message: formatNodeStrategyAnswer(evidence),
          };
        }
        if (/\b(selected\s+hand|this\s+hand|combo|a5s|why\s+is)\b/i.test(text)) {
          const evidence = await executeStudyEvidenceTool(
            deps.evidenceHost,
            QUERY_SELECTED_HAND_TOOL.name,
            {},
          );
          return {
            kind: "answer",
            provider: "fake",
            message: JSON.stringify(evidence),
          };
        }
      }
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
      requestRevision,
      baseDraft,
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

function answerToolDefinition() {
  return {
    type: "function" as const,
    function: {
      name: ANSWER_TOOL,
      description:
        "Answer a product/help, general poker, or Study-evidence question without changing the Build draft. Call after any needed evidence tools.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["message"],
        properties: {
          message: { type: "string" },
        },
      },
    },
  };
}

function setupToolDefinition() {
  return {
    type: "function" as const,
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
  };
}

function evidenceToolDefinitions() {
  return STUDY_EVIDENCE_TOOL_SCHEMAS.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/** Tools exposed for a classified turn — Q&A never receives the setup tool. */
export function openaiToolsForIntent(intent: AssistantTurnIntent) {
  if (intent === "setup") {
    return [setupToolDefinition(), answerToolDefinition()];
  }
  if (intent === "clarify") {
    return [answerToolDefinition()];
  }
  return [answerToolDefinition(), ...evidenceToolDefinitions()];
}

/**
 * OpenAI unified client: model chooses answer_user, setup, or bounded Study
 * evidence tools (strategy / bluffs / selected hand). Evidence tools run locally
 * through StudyEvidenceHost with a small round budget.
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

    // Capture freshness / identity BEFORE credential lookup or provider fetch.
    // session.run() after the network must stamp with these values — never
    // re-read getRevision() and relabel a stale proposal with a newer revision.
    const requestRevision = request.draftRevision;
    const baseDraft = deps.getDraft();

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
      draftRevision: requestRevision,
      availableProfiles: request.availableProfiles,
      capabilities: request.capabilities,
      contextSnapshot: request.contextSnapshot ?? null,
      analysisTools: {
        available: [...STUDY_NODE_EVIDENCE_TOOL_NAMES],
        note:
          "Use query_node_strategy / list_bluff_candidates / query_selected_hand_analysis for live Study evidence at the current decision only — they wait on the Study analysis scheduler and do not change Study selection. Use compare_runouts to open Compare runouts with card filters and frequency ranking on the current line (wrong seat/size → path hint or supported actions). Never start a solve.",
        deferred: [...STUDY_EVIDENCE_DEFERRED_TOOLS],
        selectedHandSchemaStatus: SELECTED_HAND_ANALYSIS_TOOL_SCHEMA.status,
      },
    });

    const messages: ChatMessage[] = [
      { role: "system", content: buildUnifiedAssistantSystemPrompt() },
      ...history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content.slice(0, ASSISTANT_MAX_TEXT_LENGTH),
      })),
      { role: "user", content: userPayload },
    ];

    const intent = classifyAssistantTurnIntent(text);
    if (intent === "clarify") {
      return {
        kind: "answer",
        provider: "openai",
        message: CLARIFY_MUTATION_MESSAGE,
      };
    }
    const setupForced = intent === "setup";
    const tools = openaiToolsForIntent(intent);
    let evidenceRounds = 0;
    let lastOpenInStudy: UnifiedChatOpenInStudy | undefined;

    while (evidenceRounds <= ASSISTANT_EVIDENCE_TOOL_MAX_ROUNDS) {
      const payload = await this.providerRequest({
        credential,
        messages,
        tools,
        toolChoice: setupForced
          ? { type: "function", function: { name: SETUP_TOOL } }
          : "auto",
        signal: request.signal,
      });

      const tool = extractToolCall(payload);

      if (tool.name === ANSWER_TOOL) {
        const message =
          typeof tool.args.message === "string" && tool.args.message.trim()
            ? tool.args.message.trim()
            : "I could not form an answer.";
        return {
          kind: "answer",
          provider: "openai",
          message,
          ...(lastOpenInStudy ? { openInStudy: lastOpenInStudy } : {}),
        };
      }

      if (tool.name === SETUP_TOOL) {
        if (!setupForced) {
          // Q&A turns must never reach the setup resolver / Build writes.
          return {
            kind: "answer",
            provider: "openai",
            message: CLARIFY_MUTATION_MESSAGE,
          };
        }
        return this.resolveSetupTool({
          text,
          toolArgs: tool.args,
          request,
          deps,
          requestRevision,
          baseDraft,
        });
      }

      if (isStudyEvidenceToolName(tool.name)) {
        if (setupForced) {
          throw new AssistantProviderError(
            "invalid_response",
            "Evidence tools are not used on setup-shaped requests",
          );
        }
        if (!deps.evidenceHost) {
          messages.push({
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: tool.id,
                type: "function",
                function: {
                  name: tool.name,
                  arguments: JSON.stringify(tool.args),
                },
              },
            ],
          });
          messages.push({
            role: "tool",
            tool_call_id: tool.id,
            content: JSON.stringify({
              ok: false,
              absences: [
                "Study evidence host is not mounted — only contextSnapshot fields are available.",
              ],
            }),
          });
          evidenceRounds += 1;
          continue;
        }

        const result = await executeStudyEvidenceTool(
          deps.evidenceHost,
          tool.name,
          tool.args,
        );
        const openTarget = openInStudyFromEvidence(tool.name, result);
        if (openTarget) {
          lastOpenInStudy = openTarget;
        }
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: tool.id,
              type: "function",
              function: {
                name: tool.name,
                arguments: JSON.stringify(tool.args),
              },
            },
          ],
        });
        messages.push({
          role: "tool",
          tool_call_id: tool.id,
          content: serializeEvidenceToolResult(result),
        });
        evidenceRounds += 1;
        continue;
      }

      // Fallback: treat plain text content as an answer.
      const content = extractPlainContent(payload);
      if (content) {
        return {
          kind: "answer",
          provider: "openai",
          message: content,
          ...(lastOpenInStudy ? { openInStudy: lastOpenInStudy } : {}),
        };
      }

      throw new AssistantProviderError(
        "invalid_response",
        `Unexpected tool: ${tool.name || "(none)"}`,
      );
    }

    throw new AssistantProviderError(
      "invalid_response",
      `Exceeded ${ASSISTANT_EVIDENCE_TOOL_MAX_ROUNDS} Study evidence tool rounds without an answer`,
    );
  }

  private async providerRequest(args: {
    credential: string;
    messages: ChatMessage[];
    tools: ReturnType<typeof openaiToolsForIntent>;
    toolChoice: "auto" | { type: "function"; function: { name: string } };
    signal?: AbortSignal;
  }): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${args.credential}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          messages: args.messages,
          tools: args.tools,
          // Setup-shaped requests must emit the setup tool — plain-text
          // "I proposed a change" answers leave Build untouched with no Apply UI.
          tool_choice: args.toolChoice,
        }),
        signal: args.signal,
      });
    } catch (err) {
      if (args.signal?.aborted) {
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

    try {
      return await response.json();
    } catch {
      throw new AssistantProviderError(
        "invalid_response",
        "OpenAI response was not valid JSON",
      );
    }
  }

  private async resolveSetupTool(args: {
    text: string;
    toolArgs: Record<string, unknown>;
    request: UnifiedChatRequest;
    deps: UnifiedChatDeps;
    requestRevision: number;
    baseDraft: SpotDraft;
  }): Promise<UnifiedChatOutcome> {
    const proposal = parseInterpretProposal(args.toolArgs);
    // Re-resolve through the session so catalogue / generate / interpolate stay app-side.
    // Pass pre-captured revision/draft so bridging does not stamp after the network.
    const bridgingProvider: AssistantProvider = {
      interpret: async (_req: InterpretRequest) => proposal,
    };
    const run = await this.session.run(args.text, {
      provider: bridgingProvider,
      catalogue: args.deps.catalogue,
      getDraft: args.deps.getDraft,
      getRevision: args.deps.getRevision,
      preferences: args.deps.preferences,
      signal: args.request.signal,
      setupSummary: args.request.setupSummary,
      preferencesSummary: args.request.preferencesSummary,
      availableProfiles: args.request.availableProfiles,
      capabilities: args.request.capabilities,
      requestRevision: args.requestRevision,
      baseDraft: args.baseDraft,
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
}

function extractToolCall(payload: unknown): {
  id: string;
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
    return { id: "", name: "", args: {} };
  }
  const call = toolCalls[0] as {
    id?: unknown;
    function?: { name?: unknown; arguments?: unknown };
  };
  const id = typeof call.id === "string" && call.id ? call.id : "tool_0";
  const fn = call.function;
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
  return { id, name, args };
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
