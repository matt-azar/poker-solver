import type { StudySetupIntent, StudySetupTreePreset } from "../setup/types";
import { buildSetupAssistantSystemPrompt } from "./contextPacks";
import {
  ASSISTANT_MAX_TEXT_LENGTH,
  AssistantProviderError,
  DEFAULT_ASSISTANT_CAPABILITIES,
  type AssistantProvider,
  type GeneratedRangesProposal,
  type InterpretProposal,
  type InterpretRequest,
  type ProfileMeta,
} from "./provider";

/**
 * Default Chat Completions model for study-setup interpretation.
 * Small/cheap extraction model; swap via OpenAiAssistantProviderOptions.model.
 * Live quality validation against production wording remains outstanding.
 */
export const OPENAI_ASSISTANT_DEFAULT_MODEL = "gpt-4.1-mini";

export const OPENAI_CHAT_COMPLETIONS_URL =
  "https://api.openai.com/v1/chat/completions";

export interface OpenAiAssistantProviderOptions {
  /** Injected credential lookup — never hardcode or import env into a webview constant. */
  getCredential: () => Promise<string | null>;
  model?: string;
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

const INTERPRET_TOOL_NAME = "emit_study_setup_proposal";

/**
 * Replaceable hosted OpenAI adapter.
 * Credentials come from `getCredential` (desktop secret store / backend proxy).
 * Full range weights must never be logged or requested from the model.
 */
export class OpenAiAssistantProvider implements AssistantProvider {
  private readonly getCredential: () => Promise<string | null>;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;

  constructor(options: OpenAiAssistantProviderOptions) {
    this.getCredential = options.getCredential;
    this.model = options.model ?? OPENAI_ASSISTANT_DEFAULT_MODEL;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.endpoint = options.endpoint ?? OPENAI_CHAT_COMPLETIONS_URL;
  }

  async interpret(request: InterpretRequest): Promise<InterpretProposal> {
    const text = request.text ?? "";
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
        "No OpenAI credential available for the study setup assistant",
      );
    }

    const body = {
      model: this.model,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: SETUP_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: buildUserPayload(request),
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: INTERPRET_TOOL_NAME,
            description:
              "Emit a structured study-setup proposal. Never include range weight strings.",
            parameters: INTERPRET_JSON_SCHEMA,
          },
        },
      ],
      tool_choice: {
        type: "function",
        function: { name: INTERPRET_TOOL_NAME },
      },
    };

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${credential}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Network request failed";
      throw new AssistantProviderError("network", message);
    }

    if (!response.ok) {
      // Do not include response bodies that might echo credentials.
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

    const toolArgs = extractToolArguments(payload);
    return parseInterpretProposal(toolArgs);
  }
}

/** Built from docs/ai-context/setup-assistant.md plus operational tool rules. */
const SETUP_SYSTEM_PROMPT = buildSetupAssistantSystemPrompt();

function buildUserPayload(request: InterpretRequest): string {
  // Metadata only — no full ranges.
  return JSON.stringify({
    text: request.text.slice(0, ASSISTANT_MAX_TEXT_LENGTH),
    setupSummary: request.setupSummary,
    preferencesSummary: request.preferencesSummary,
    capabilities: request.capabilities.length
      ? request.capabilities
      : [...DEFAULT_ASSISTANT_CAPABILITIES],
    draftRevision: request.draftRevision,
    availableProfiles: request.availableProfiles.map(sanitizeProfileMeta),
  });
}

function sanitizeProfileMeta(meta: ProfileMeta): ProfileMeta {
  return {
    id: meta.id,
    displayName: meta.displayName,
    classification: meta.classification,
    positions: { oop: meta.positions.oop, ip: meta.positions.ip },
    startingStackBb: meta.startingStackBb,
    openSizeBb: meta.openSizeBb,
    format: meta.format,
    stakesLabel: meta.stakesLabel,
    potType: meta.potType,
    legacyPreset: meta.legacyPreset,
  };
}

const INTERPRET_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: {
      type: "string",
      enum: [
        "prepare_study",
        "update_study",
        "duplicate_study",
        "clarify",
        "unsupported",
        "unrelated",
      ],
    },
    intent: { type: "object" },
    selectedProfileId: { type: "string" },
    board: { type: "string" },
    treeEdits: { type: "object" },
    stackBb: { type: "number" },
    openSizeBb: { type: "number" },
    stakesLabel: { type: "string" },
    generatedRanges: {
      type: "object",
      additionalProperties: false,
      required: ["oop", "ip"],
      properties: {
        oop: { type: "string" },
        ip: { type: "string" },
        note: { type: "string" },
      },
    },
    interpolateFromIds: {
      type: "array",
      items: { type: "string" },
      minItems: 2,
      maxItems: 2,
    },
    questions: { type: "array", items: { type: "string" } },
    candidates: { type: "array", items: { type: "object" } },
    message: { type: "string" },
  },
} as const;

function extractToolArguments(payload: unknown): unknown {
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
    throw new AssistantProviderError(
      "invalid_response",
      "OpenAI message missing tool_calls",
    );
  }
  const fn = (toolCalls[0] as { function?: { arguments?: unknown } }).function;
  const rawArgs = fn?.arguments;
  if (typeof rawArgs !== "string") {
    throw new AssistantProviderError(
      "invalid_response",
      "OpenAI tool call missing arguments string",
    );
  }
  try {
    return JSON.parse(rawArgs) as unknown;
  } catch {
    throw new AssistantProviderError(
      "invalid_response",
      "OpenAI tool arguments were not valid JSON",
    );
  }
}

/**
 * Independently validate/parse model JSON into InterpretProposal.
 * Rejects script/shell/path-like payloads and any range-weight fields.
 */
export function parseInterpretProposal(raw: unknown): InterpretProposal {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AssistantProviderError(
      "invalid_response",
      "Proposal must be a JSON object",
    );
  }
  const obj = raw as Record<string, unknown>;
  rejectDangerousPayload(obj);

  const kind = obj.kind;
  if (kind === "clarify") {
    const questions = asStringArray(obj.questions);
    if (questions.length === 0) {
      throw new AssistantProviderError(
        "invalid_response",
        "clarify requires questions",
      );
    }
    return {
      kind: "clarify",
      questions,
      candidates: Array.isArray(obj.candidates)
        ? (obj.candidates as ProfileMeta[])
        : undefined,
    };
  }
  if (kind === "unsupported" || kind === "unrelated") {
    const message =
      typeof obj.message === "string" && obj.message.trim()
        ? obj.message.trim()
        : kind === "unsupported"
          ? "Unsupported request"
          : "Unrelated request";
    return { kind, message };
  }
  if (
    kind === "prepare_study" ||
    kind === "update_study" ||
    kind === "duplicate_study"
  ) {
    const intent = normalizeIntent(obj.intent, kind);
    const proposal: InterpretProposal = {
      kind,
      intent,
      selectedProfileId:
        typeof obj.selectedProfileId === "string"
          ? obj.selectedProfileId
          : undefined,
      board: typeof obj.board === "string" ? obj.board : intent.board,
      treeEdits: asTreeEdits(obj.treeEdits) ?? intent.treePreset,
      stackBb:
        typeof obj.stackBb === "number"
          ? obj.stackBb
          : intent.stackBb,
      openSizeBb:
        typeof obj.openSizeBb === "number"
          ? obj.openSizeBb
          : intent.openSizeBb,
      stakesLabel:
        typeof obj.stakesLabel === "string"
          ? obj.stakesLabel
          : intent.stakesLabel,
      generatedRanges: asGeneratedRanges(obj.generatedRanges),
      interpolateFromIds: asInterpolateIds(obj.interpolateFromIds),
    };
    rejectUnguardedRangeWeights(proposal);
    return proposal;
  }

  throw new AssistantProviderError(
    "invalid_response",
    `Unknown proposal kind: ${String(kind)}`,
  );
}

function normalizeIntent(
  raw: unknown,
  kind: "prepare_study" | "update_study" | "duplicate_study",
): StudySetupIntent {
  const mode =
    kind === "prepare_study"
      ? "create"
      : kind === "duplicate_study"
        ? "duplicate"
        : "edit";
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { mode };
  }
  const src = raw as Record<string, unknown>;
  rejectDangerousPayload(src);
  // Intent must not smuggle raw ranges — use top-level generatedRanges instead.
  rejectRangeWeightFields(src);

  const intent: StudySetupIntent = {
    mode:
      src.mode === "create" || src.mode === "edit" || src.mode === "duplicate"
        ? src.mode
        : mode,
  };
  if (typeof src.oopPosition === "string") intent.oopPosition = src.oopPosition;
  if (typeof src.ipPosition === "string") intent.ipPosition = src.ipPosition;
  if (typeof src.stakesLabel === "string") intent.stakesLabel = src.stakesLabel;
  if (
    src.potType === "SRP" ||
    src.potType === "3BP" ||
    src.potType === "4BP"
  ) {
    intent.potType = src.potType;
  }
  if (typeof src.stackBb === "number") intent.stackBb = src.stackBb;
  if (typeof src.openSizeBb === "number") intent.openSizeBb = src.openSizeBb;
  if (typeof src.board === "string") intent.board = src.board;
  if (typeof src.profileQuery === "string") intent.profileQuery = src.profileQuery;
  const tree = asTreeEdits(src.treePreset);
  if (tree) intent.treePreset = tree;
  return intent;
}

function asTreeEdits(raw: unknown): StudySetupTreePreset | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const src = raw as Record<string, unknown>;
  const out: StudySetupTreePreset = {};
  for (const key of [
    "oopBets",
    "ipBets",
    "oopFlop",
    "ipFlop",
    "oopTurn",
    "ipTurn",
    "oopRiver",
    "ipRiver",
    "oopDonk",
  ] as const) {
    if (typeof src[key] === "string") {
      out[key] = src[key];
    }
  }
  if (typeof src.potCap === "number") out.potCap = src.potCap;
  if (typeof src.noThreeBet === "boolean") out.noThreeBet = src.noThreeBet;
  if (typeof src.geometric === "boolean") out.geometric = src.geometric;
  if (typeof src.maxRaises === "number") out.maxRaises = src.maxRaises;
  return Object.keys(out).length > 0 ? out : undefined;
}

function asStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

const DANGEROUS_KEY_RE =
  /^(script|shell|command|exec|spawn|path|filePath|filepath|cwd|argv|env|credential|apiKey|api_key|authorization)$/i;

const DANGEROUS_VALUE_RE =
  /(?:^|[\s;`])(?:bash|sh|zsh|powershell|cmd\.exe|\/bin\/|file:\/\/|https?:\/\/|\$\{)/i;

function rejectDangerousPayload(obj: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(obj)) {
    if (DANGEROUS_KEY_RE.test(key)) {
      throw new AssistantProviderError(
        "rejected_payload",
        `Rejected dangerous proposal field: ${key}`,
      );
    }
    if (typeof value === "string" && DANGEROUS_VALUE_RE.test(value)) {
      throw new AssistantProviderError(
        "rejected_payload",
        "Rejected script/shell/path-like proposal value",
      );
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      rejectDangerousPayload(value as Record<string, unknown>);
    }
  }
}

const RANGE_WEIGHT_KEYS = new Set([
  "oopRange",
  "ipRange",
  "oop_range",
  "ip_range",
  "ranges",
  "rangeWeights",
  "range_weights",
]);

function rejectRangeWeightFields(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    if (RANGE_WEIGHT_KEYS.has(key)) {
      throw new AssistantProviderError(
        "rejected_payload",
        "Range weights belong in generatedRanges, not intent fields",
      );
    }
  }
}

function asGeneratedRanges(raw: unknown): GeneratedRangesProposal | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const src = raw as Record<string, unknown>;
  if (typeof src.oop !== "string" || typeof src.ip !== "string") {
    return undefined;
  }
  return {
    oop: src.oop,
    ip: src.ip,
    note: typeof src.note === "string" ? src.note : undefined,
  };
}

function asInterpolateIds(raw: unknown): [string, string] | undefined {
  if (!Array.isArray(raw) || raw.length !== 2) {
    return undefined;
  }
  const a = raw[0];
  const b = raw[1];
  if (typeof a !== "string" || typeof b !== "string") {
    return undefined;
  }
  const left = a.trim();
  const right = b.trim();
  if (!left || !right) {
    return undefined;
  }
  return [left, right];
}

/** Allow guarded generatedRanges; reject smuggled intent range fields. */
function rejectUnguardedRangeWeights(proposal: InterpretProposal): void {
  if (
    proposal.kind === "prepare_study" ||
    proposal.kind === "update_study" ||
    proposal.kind === "duplicate_study"
  ) {
    rejectRangeWeightFields(proposal.intent as unknown as Record<string, unknown>);
  }
}

export function createOpenAiAssistantProvider(
  options: OpenAiAssistantProviderOptions,
): OpenAiAssistantProvider {
  return new OpenAiAssistantProvider(options);
}
