import { describe, expect, it, vi } from "vitest";
import {
  buildHelpSystemPrompt,
  buildSetupAssistantSystemPrompt,
  loadAssistantContextPack,
} from "../assistant/contextPacks";
import {
  createFakeHelpChatClient,
  createOpenAiHelpChatClient,
} from "./helpChat";
import { AssistantProviderError } from "../assistant/provider";

describe("ai context packs", () => {
  it("loads help and setup-assistant packs with expected anchors", () => {
    const help = loadAssistantContextPack("help");
    const setup = loadAssistantContextPack("setup-assistant");
    expect(help).toContain("Hold'em Study");
    expect(help).toContain("Study assistant");
    expect(setup).toContain("emit_study_setup_proposal");
    expect(setup).toContain("Pot type");
    expect(buildHelpSystemPrompt()).toContain("Reply format");
    expect(buildSetupAssistantSystemPrompt()).toContain("Context pack");
  });
});

describe("FakeHelpChatClient", () => {
  it("points setup-style questions at the Setup assistant", async () => {
    const client = createFakeHelpChatClient();
    const reply = await client.ask({
      question: "How do I set up CO vs BB SRP with 100NL ranges?",
    });
    expect(reply.provider).toBe("fake");
    expect(reply.message).toMatch(/Setup assistant/i);
  });

  it("answers solve-control questions", async () => {
    const client = createFakeHelpChatClient();
    const reply = await client.ask({ question: "How do I pause a solve?" });
    expect(reply.message).toMatch(/Pause/i);
  });
});

describe("OpenAiHelpChatClient", () => {
  it("sends the help context pack as the system message", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "Use Build then Solve." } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const client = createOpenAiHelpChatClient({
      getCredential: async () => "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const reply = await client.ask({ question: "Where do I build a spot?" });
    expect(reply.message).toBe("Use Build then Solve.");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0]?.role).toBe("system");
    expect(body.messages[0]?.content).toContain("Hold'em Study");
    expect(body.messages[0]?.content).toContain("product help section");
    expect(body.messages.at(-1)?.content).toBe("Where do I build a spot?");
  });

  it("requires a credential", async () => {
    const client = createOpenAiHelpChatClient({
      getCredential: async () => null,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    await expect(client.ask({ question: "hello" })).rejects.toBeInstanceOf(
      AssistantProviderError,
    );
  });
});
