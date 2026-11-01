import { describe, expect, it, vi } from "vitest";
import {
  buildUnifiedAssistantSystemPrompt,
  loadAssistantContextPack,
} from "./contextPacks";
import {
  createFakeUnifiedChatClient,
  createOpenAiUnifiedChatClient,
  looksLikeSetupRequest,
} from "./unifiedChat";
import { createRangeProfileCatalogue } from "../profiles";
import { emptyStudySetupPreferences } from "../setup";
import type { SpotDraft } from "../types";

function emptyDraft(): SpotDraft {
  return {
    boardText: "",
    oopRange: "AA",
    ipRange: "KK",
    pot: 5.5,
    stack: 97.5,
    oopBets: "",
    ipBets: "",
    oopFlop: "",
    ipFlop: "",
    oopTurn: "",
    ipTurn: "",
    oopRiver: "",
    ipRiver: "",
    oopDonk: "",
    potCap: 1,
    noThreeBet: false,
    geometric: false,
    allInThreshold: 0,
    allowAllIn: true,
    frozen: false,
    accuracy: "",
    maxRaises: 0,
    iterations: 0,
    memoryMib: 0,
    threads: 0,
    algorithm: "",
    samples: 0,
    rakeRate: 0,
    rakeCap: 0,
    useIcm: false,
    icmStacks: "",
    icmPayouts: "",
    incentives: "",
    edgeTags: "",
    timeLimit: "",
    solutionPath: "",
    treeEdits: [],
  };
}

describe("looksLikeSetupRequest", () => {
  it("detects setup phrasing", () => {
    expect(looksLikeSetupRequest("Set up CO vs BB SRP")).toBe(true);
    expect(looksLikeSetupRequest("Change the flop to As 7d 2c")).toBe(true);
    expect(looksLikeSetupRequest("Duplicate this setup at 150bb")).toBe(true);
    expect(looksLikeSetupRequest("set iterations to 500")).toBe(true);
    expect(looksLikeSetupRequest("set pot to 40")).toBe(true);
  });

  it("leaves product questions as non-setup", () => {
    expect(looksLikeSetupRequest("How do I run a solve?")).toBe(false);
    expect(looksLikeSetupRequest("What does accuracy mean?")).toBe(false);
  });
});

describe("context packs", () => {
  it("loads the unified pack", () => {
    const unified = loadAssistantContextPack("unified");
    expect(unified).toContain("unified Study assistant");
    expect(unified).toContain("answer_user");
    expect(unified).toContain("emit_study_setup_proposal");
    expect(buildUnifiedAssistantSystemPrompt()).toContain("Call exactly one tool");
  });
});

describe("FakeUnifiedChatClient", () => {
  it("answers help questions without a setup run", async () => {
    const client = createFakeUnifiedChatClient();
    const catalogue = createRangeProfileCatalogue();
    const outcome = await client.turn(
      {
        text: "How do I pause a solve?",
        setupSummary: "test",
        availableProfiles: [],
        draftRevision: 1,
      },
      {
        catalogue,
        getDraft: emptyDraft,
        getRevision: () => 1,
        preferences: emptyStudySetupPreferences(),
      },
    );
    expect(outcome.kind).toBe("answer");
    if (outcome.kind === "answer") {
      expect(outcome.message).toMatch(/Pause/i);
    }
  });

  it("routes setup requests into a setup outcome", async () => {
    const client = createFakeUnifiedChatClient();
    const catalogue = createRangeProfileCatalogue();
    const outcome = await client.turn(
      {
        text: "Set up CO vs BB SRP",
        setupSummary: "test",
        availableProfiles: [],
        draftRevision: 1,
      },
      {
        catalogue,
        getDraft: emptyDraft,
        getRevision: () => 1,
        preferences: emptyStudySetupPreferences(),
      },
    );
    expect(outcome.kind).toBe("setup");
    if (outcome.kind === "setup") {
      expect(outcome.proposal.kind === "prepare_study" || outcome.proposal.kind === "clarify").toBe(
        true,
      );
    }
  });
});

describe("OpenAiUnifiedChatClient", () => {
  it("maps answer_user tool calls to answers", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: "answer_user",
                      arguments: JSON.stringify({ message: "Use Solve from the menu." }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const client = createOpenAiUnifiedChatClient({
      getCredential: async () => "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const catalogue = createRangeProfileCatalogue();
    const outcome = await client.turn(
      {
        text: "How do I solve?",
        setupSummary: "test",
        availableProfiles: [],
        draftRevision: 1,
      },
      {
        catalogue,
        getDraft: emptyDraft,
        getRevision: () => 1,
        preferences: emptyStudySetupPreferences(),
      },
    );
    expect(outcome.kind).toBe("answer");
    if (outcome.kind === "answer") {
      expect(outcome.message).toBe("Use Solve from the menu.");
    }
    const body = JSON.parse(String((fetchImpl.mock.calls[0]?.[1] as RequestInit).body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0]?.content).toContain("unified Study assistant");
  });
});
