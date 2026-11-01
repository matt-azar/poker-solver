import {
  buildHelpSystemPrompt,
  loadAssistantContextPack,
} from "../assistant/contextPacks";
import {
  ASSISTANT_MAX_TEXT_LENGTH,
  AssistantProviderError,
} from "../assistant/provider";
import {
  OPENAI_ASSISTANT_DEFAULT_MODEL,
  OPENAI_CHAT_COMPLETIONS_URL,
} from "../assistant/openaiProvider";

export type HelpChatRole = "user" | "assistant";

export interface HelpChatMessage {
  role: HelpChatRole;
  content: string;
}

export interface HelpChatRequest {
  /** Latest user question (also appended to messages if not already last). */
  question: string;
  /** Prior turns excluding the system prompt. */
  history?: HelpChatMessage[];
  signal?: AbortSignal;
}

export interface HelpChatReply {
  message: string;
  provider: "fake" | "openai";
}

export interface HelpChatClient {
  ask(request: HelpChatRequest): Promise<HelpChatReply>;
}

export interface OpenAiHelpChatOptions {
  getCredential: () => Promise<string | null>;
  model?: string;
  fetchImpl?: typeof fetch;
  endpoint?: string;
  systemPrompt?: string;
}

const HELP_MAX_HISTORY = 12;

/**
 * Hosted Help Q&A — free-form chat with the product help context pack.
 * Shares credential lookup with the setup assistant; does not emit tools or drafts.
 */
export class OpenAiHelpChatClient implements HelpChatClient {
  private readonly getCredential: () => Promise<string | null>;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;
  private readonly systemPrompt: string;

  constructor(options: OpenAiHelpChatOptions) {
    this.getCredential = options.getCredential;
    this.model = options.model ?? OPENAI_ASSISTANT_DEFAULT_MODEL;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.endpoint = options.endpoint ?? OPENAI_CHAT_COMPLETIONS_URL;
    this.systemPrompt = options.systemPrompt ?? buildHelpSystemPrompt();
  }

  async ask(request: HelpChatRequest): Promise<HelpChatReply> {
    const question = request.question.trim();
    if (!question) {
      throw new AssistantProviderError("invalid_response", "Empty help question");
    }
    if (question.length > ASSISTANT_MAX_TEXT_LENGTH) {
      throw new AssistantProviderError(
        "text_too_long",
        `Request text exceeds ${ASSISTANT_MAX_TEXT_LENGTH} characters`,
      );
    }

    const credential = await this.getCredential();
    if (!credential) {
      throw new AssistantProviderError(
        "missing_credential",
        "No OpenAI credential available for Help chat",
      );
    }

    const history = (request.history ?? [])
      .filter((m) => m.content.trim().length > 0)
      .slice(-HELP_MAX_HISTORY);

    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: this.systemPrompt },
      ...history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content.slice(0, ASSISTANT_MAX_TEXT_LENGTH),
      })),
    ];

    const last = history[history.length - 1];
    if (!last || last.role !== "user" || last.content.trim() !== question) {
      messages.push({ role: "user", content: question });
    }

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
          temperature: 0.2,
          messages,
        }),
        signal: request.signal,
      });
    } catch (err) {
      if (request.signal?.aborted) {
        throw new AssistantProviderError("network", "Help request cancelled");
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

    const content = extractAssistantText(payload);
    return { message: content, provider: "openai" };
  }
}

/** Deterministic offline Help replies for demos and tests. */
export class FakeHelpChatClient implements HelpChatClient {
  async ask(request: HelpChatRequest): Promise<HelpChatReply> {
    const q = request.question.trim().toLowerCase();
    if (!q) {
      throw new AssistantProviderError("invalid_response", "Empty help question");
    }

    if (/setup|catalogue|100nl|range profile|prepare a study/.test(q)) {
      return {
        provider: "fake",
        message:
          "Describe the study in this Study assistant (e.g. Set up CO vs BB SRP with 100NL ranges). Conflict-free changes are written onto the Build fields. Undo is available in the assistant.",
      };
    }
    if (/\b(shortcuts?|hotkeys?|keyboard)\b/.test(q)) {
      return {
        provider: "fake",
        message:
          "Press ? for the shortcut list. Common ones: S solve, C continue, X stop. Shortcuts are ignored while typing in a field.",
      };
    }
    if (/solve|pause|continue|stop/.test(q)) {
      return {
        provider: "fake",
        message:
          "Use Solve (S) from the Solve menu when the engine is connected and the Build draft is valid. Pause stops at a chunk boundary; Continue resumes the same solution; Stop ends the run. Solving is local via explorer — it does not need OpenAI.",
      };
    }
    if (/workspace|build|study|compare|library/.test(q)) {
      return {
        provider: "fake",
        message:
          "Workspaces: Build (set up the spot), Study (browse strategy after a solve), Compare (vs baseline), Library (recent solutions and range templates).",
      };
    }
    if (/equity|nash|ev|accuracy/.test(q)) {
      return {
        provider: "fake",
        message:
          "Action EV defaults to local decision EV (Fold = 0). Chip EV is root-centered. Accuracy/Nash gap is NashConv (sum of BR gains), reported as NashConv/pot. Equity is check-down pot fraction — not chip EV.",
      };
    }

    // Ensure the bundled pack is present in the fake path so tests catch empty packs.
    const pack = loadAssistantContextPack("help");
    if (!pack.includes("Hold'em Study")) {
      throw new AssistantProviderError(
        "invalid_response",
        "Help context pack failed to load",
      );
    }

    return {
      provider: "fake",
      message:
        "Hold'em Study is a local postflop solver UI. Build a spot, Solve, then browse on Study. Ask about solve controls, workspaces, EV labels, or describe a study here to prepare ranges and parameters.",
    };
  }
}

function extractAssistantText(payload: unknown): string {
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
  const content = (message as { content?: unknown }).content;
  if (typeof content !== "string" || !content.trim()) {
    throw new AssistantProviderError(
      "invalid_response",
      "OpenAI message missing text content",
    );
  }
  return content.trim();
}

export function createOpenAiHelpChatClient(
  options: OpenAiHelpChatOptions,
): OpenAiHelpChatClient {
  return new OpenAiHelpChatClient(options);
}

export function createFakeHelpChatClient(): FakeHelpChatClient {
  return new FakeHelpChatClient();
}
