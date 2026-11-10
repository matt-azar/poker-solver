import { describe, expect, it, vi } from "vitest";
import {
  buildUnifiedAssistantSystemPrompt,
  loadAssistantContextPack,
} from "./contextPacks";
import {
  ASSISTANT_MAX_TEXT_LENGTH,
} from "./provider";
import {
  classifyAssistantTurnIntent,
  createFakeUnifiedChatClient,
  createOpenAiUnifiedChatClient,
  looksLikeSetupRequest,
  openaiToolsForIntent,
  serializeEvidenceToolResult,
} from "./unifiedChat";
import {
  buildAssistantContextSnapshot,
  summarizeContextSnapshot,
} from "./contextSnapshot";
import { createRangeProfileCatalogue } from "../profiles";
import { parseRangeText, snapshotWeights } from "../range";
import {
  applySetupTransaction,
  emptyStudySetupPreferences,
} from "../setup";
import type { SpotDraft } from "../types";
import { commitAssistantSetup } from "./commitAssistantSetup";

function emptyDraft(): SpotDraft {
  return {
    boardText: "",
    oopRange: "AA",
    ipRange: "KK",
    pot: 5.5,
    stack: 97.5,
    oopBets: "",
    ipBets: "",
    oopRaises: "",
    ipRaises: "",
    oopFlop: "",
    ipFlop: "",
    oopTurn: "",
    ipTurn: "",
    oopRiver: "",
    ipRiver: "",
    oopFlopRaises: "",
    ipFlopRaises: "",
    oopTurnRaises: "",
    ipTurnRaises: "",
    oopRiverRaises: "",
    ipRiverRaises: "",
    oopDonk: "",
    oopFlopDonk: "",
    oopTurnDonk: "",
    oopRiverDonk: "",
    donkFlop: false,
    donkTurn: false,
    donkRiver: false,
    mergeThresholdPct: 0,
    potCap: 1,
    noThreeBet: false,
    allInThreshold: 0,
    allowAllIn: false,
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

describe("looksLikeSetupRequest / classifyAssistantTurnIntent", () => {
  it("detects explicit setup phrasing", () => {
    expect(looksLikeSetupRequest("Set up CO vs BB SRP")).toBe(true);
    expect(looksLikeSetupRequest("Set up CO vs BB SRP with 100NL ranges.")).toBe(true);
    expect(looksLikeSetupRequest("Change the flop to As 7d 2c")).toBe(true);
    expect(looksLikeSetupRequest("Duplicate this setup at 150bb")).toBe(true);
    expect(looksLikeSetupRequest("set iterations to 500")).toBe(true);
    expect(looksLikeSetupRequest("set pot to 40")).toBe(true);
    expect(looksLikeSetupRequest("make pot 55")).toBe(true);
    expect(looksLikeSetupRequest("pot to 55")).toBe(true);
    expect(looksLikeSetupRequest("Can you set the stack to 150?")).toBe(true);
  });

  it("keeps help and Study Q&A off the setup path", () => {
    expect(looksLikeSetupRequest("How do I run a solve?")).toBe(false);
    expect(looksLikeSetupRequest("What does accuracy mean?")).toBe(false);
    expect(looksLikeSetupRequest("How do I set up CO vs BB SRP with 100NL ranges?")).toBe(
      false,
    );
    expect(looksLikeSetupRequest("How do I set the stack to 150?")).toBe(false);
    expect(looksLikeSetupRequest("At this 3BP node, which hands bluff?")).toBe(false);
    expect(looksLikeSetupRequest("What does IP do facing 75%?")).toBe(false);
    expect(looksLikeSetupRequest("Where can I compare river cards?")).toBe(false);
    expect(classifyAssistantTurnIntent("How do I set up CO vs BB SRP with 100NL ranges?")).toBe(
      "qa",
    );
    expect(classifyAssistantTurnIntent("At this 3BP node, which hands bluff?")).toBe("qa");
  });

  it("exposes only Q&A tools on the qa intent", () => {
    const qaTools = openaiToolsForIntent("qa").map((tool) => tool.function.name);
    expect(qaTools).toContain("answer_user");
    expect(qaTools).toContain("list_bluff_candidates");
    expect(qaTools).not.toContain("emit_study_setup_proposal");
    const setupTools = openaiToolsForIntent("setup").map((tool) => tool.function.name);
    expect(setupTools).toContain("emit_study_setup_proposal");
  });
});

describe("context packs", () => {
  it("loads a single assembled unified pack without duplicate surface/setup", () => {
    const unified = loadAssistantContextPack("unified");
    expect(unified).toContain("unified Study assistant");
    expect(unified).toContain("answer_user");
    expect(unified).toContain("emit_study_setup_proposal");
    expect(unified).toContain("contextSnapshot");
    expect(unified).toContain("Equity");
    expect(unified).toContain("menu bar **Assistant**");
    expect(unified).toContain("Compare runouts");
    expect(unified).toContain("Overlay → EV+Eq");
    expect(unified).toContain("Q&A vs setup");
    expect(unified).not.toContain("Flop donk");
    expect(unified).not.toMatch(/Help\s*→\s*Study assistant/i);
    expect(unified).toContain("list_bluff_candidates");
    expect(unified).toContain("query_node_strategy");
    const prompt = buildUnifiedAssistantSystemPrompt();
    expect(prompt).toContain("list_bluff_candidates");
    expect(prompt).not.toContain("--- Help section ---");
    expect(prompt).not.toContain("--- Setup section ---");
    expect((prompt.match(/## Product surface \(mounted UI\)/g) || []).length).toBe(1);
    expect((prompt.match(/## Hard product rules/g) || []).length).toBe(1);
  });
});

describe("serializeEvidenceToolResult", () => {
  it("keeps large bluff-candidate payloads as valid JSON with metadata", () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({
      combo: `X${index.toString().padStart(2, "0")}s`,
      betFreq: 0.55 + index * 0.001,
      ev: 1.23456789 + index,
      equity: 0.123456 + index * 0.001,
      topBetAction: "Bet 75% pot on a long descriptive label",
      reach: 0.012345 + index * 0.0001,
    }));
    const evidence = {
      ok: true,
      seat: "IP",
      nodeId: "ip-face-75",
      line: "root/Bet 75",
      path: ["Root", "Bet 75"],
      equityThreshold: 0.3,
      minBetFreq: 0.01,
      minReach: 0.005,
      equityMode: "node",
      sortBy: "betFreq",
      rows,
      truncated: false,
      navigated: false,
      hops: 0,
      absences: ["Bluff candidates use node equity."],
    };
    const raw = JSON.stringify(evidence);
    expect(raw.length).toBeGreaterThan(ASSISTANT_MAX_TEXT_LENGTH);
    const encoded = serializeEvidenceToolResult(evidence);
    expect(encoded.length).toBeLessThanOrEqual(ASSISTANT_MAX_TEXT_LENGTH);
    const parsed = JSON.parse(encoded) as {
      nodeId: string;
      line: string;
      equityThreshold: number;
      truncated: boolean;
      rows: unknown[];
      absences: string[];
    };
    expect(parsed.nodeId).toBe("ip-face-75");
    expect(parsed.line).toBe("root/Bet 75");
    expect(parsed.equityThreshold).toBe(0.3);
    expect(parsed.truncated).toBe(true);
    expect(parsed.rows.length).toBeLessThan(rows.length);
    expect(parsed.absences.length).toBeGreaterThan(0);
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

  it("treats how-to setup wording as product help and leaves the draft intact", async () => {
    const client = createFakeUnifiedChatClient();
    const catalogue = createRangeProfileCatalogue();
    const draft = emptyDraft();
    const outcome = await client.turn(
      {
        text: "How do I set up CO vs BB SRP with 100NL ranges?",
        setupSummary: "test",
        availableProfiles: [],
        draftRevision: 3,
      },
      {
        catalogue,
        getDraft: () => draft,
        getRevision: () => 3,
        preferences: emptyStudySetupPreferences(),
      },
    );
    expect(outcome.kind).toBe("answer");
    expect(draft.pot).toBe(5.5);
    expect(draft.stack).toBe(97.5);
  });

  it("routes explicit setup requests into a setup outcome", async () => {
    const client = createFakeUnifiedChatClient();
    const catalogue = createRangeProfileCatalogue();
    const outcome = await client.turn(
      {
        text: "Set up CO vs BB SRP with 100NL ranges.",
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
  it("maps answer_user tool calls to answers and forwards contextSnapshot", async () => {
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
    const contextSnapshot = buildAssistantContextSnapshot({
      draft: emptyDraft(),
      draftRevision: 1,
    });
    const outcome = await client.turn(
      {
        text: "How do I solve?",
        setupSummary: summarizeContextSnapshot(contextSnapshot),
        availableProfiles: [],
        draftRevision: 1,
        contextSnapshot,
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
    const userPayload = JSON.parse(body.messages[body.messages.length - 1]?.content ?? "{}") as {
      contextSnapshot?: { version?: number };
      analysisTools?: { deferred?: string[]; available?: string[] };
    };
    expect(userPayload.contextSnapshot?.version).toBe(2);
    expect(userPayload.analysisTools?.deferred).toContain("compare_runouts");
    expect(userPayload.analysisTools?.available).toEqual(
      expect.arrayContaining([
        "query_node_strategy",
        "list_bluff_candidates",
        "query_selected_hand_analysis",
      ]),
    );
  });

  it("keeps the send-time revision when the draft changes during a delayed provider response", async () => {
    let release!: (value: Response) => void;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let fetchStarted!: () => void;
    const fetchStartedPromise = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      fetchStarted();
      return held;
    });

    let draft: SpotDraft = { ...emptyDraft(), pot: 100 };
    let revision = 0;

    const client = createOpenAiUnifiedChatClient({
      getCredential: async () => "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const catalogue = createRangeProfileCatalogue();

    const turnPromise = client.turn(
      {
        text: "Set pot to 55",
        setupSummary: "board=(none) pot=100 stack=97.5 rev=0",
        availableProfiles: [],
        draftRevision: 0,
      },
      {
        catalogue,
        getDraft: () => draft,
        getRevision: () => revision,
        preferences: emptyStudySetupPreferences(),
      },
    );

    // Wait until the provider fetch is in flight, then mutate the draft.
    await fetchStartedPromise;
    draft = { ...draft, pot: 999 };
    revision = 1;

    release(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: "emit_study_setup_proposal",
                      arguments: JSON.stringify({
                        kind: "update_study",
                        intent: { mode: "edit" },
                        fieldEdits: { pot: 55 },
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const outcome = await turnPromise;
    expect(outcome.kind).toBe("setup");
    if (outcome.kind !== "setup" || !outcome.run) {
      throw new Error("expected setup outcome with run");
    }

    // Must preserve the original send-time revision — not the mid-flight bump.
    expect(outcome.run.requestRevision).toBe(0);
    expect(outcome.run.status).toBe("stale");

    // Mounted commit path: reject stale and leave the manual pot alone.
    if (outcome.run.result) {
      expect(outcome.run.result.requestRevision).toBe(0);
      const applied = commitAssistantSetup(outcome.run.result, (result) => {
        const tx = applySetupTransaction({
          currentDraft: draft,
          currentWeights: snapshotWeights({
            oop: parseRangeText(draft.oopRange),
            ip: parseRangeText(draft.ipRange),
          }),
          currentMeta: null,
          draftRevision: revision,
          result,
        });
        if (!tx.ok) {
          return { ok: false, reason: tx.reason, message: tx.message };
        }
        draft = tx.draft;
        revision = tx.draftRevision;
        return { ok: true, undoEntry: tx.undoEntry };
      });
      expect(applied.ok).toBe(false);
      if (!applied.ok) {
        expect(applied.reason).toBe("stale");
      }
    }

    expect(draft.pot).toBe(999);
    expect(revision).toBe(1);
  });

  it("runs list_bluff_candidates then answers from tool evidence", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      id: "call_bluffs",
                      function: {
                        name: "list_bluff_candidates",
                        arguments: JSON.stringify({ seat: "IP" }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      id: "call_answer",
                      function: {
                        name: "answer_user",
                        arguments: JSON.stringify({
                          message: "IP bluffs include 7h2d at high bet frequency.",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const evidenceHost = {
      read: () => ({
        solutionId: "sol-1",
        currentNode: {
          node_id: "ip-1",
          kind: "decision" as const,
          player: 1,
          to_act: "IP",
          line: "root/Check",
          actions: ["Check", "Bet 50"],
          combos: ["7h2d"],
          reach: [1],
          marginal: [1],
          reach_defined: true,
          strategy: [[0.2, 0.8]],
        },
        nodeValues: {
          pending: false,
          node_id: "ip-1",
          solution_id: "sol-1",
          combos: ["7h2d"],
          value: [0.1],
          action_ev: [[0, 0.2]],
          ev_defined: [true],
          utility_basis: "root_centered",
          local_offset: 0,
        },
        equity: {
          pending: false,
          node_id: "ip-1",
          solution_id: "sol-1",
          ip_hands: [{ combo: "7h2d", equity: 0.1, weight: 1 }],
        },
        pathTrail: [],
        selectedCell: null,
        evDisplayBasis: "local" as const,
        status: { solution_id: "sol-1" },
      }),
      ensureNodeAnalysis: vi.fn(async () => undefined),
      navigateTo: vi.fn(async () => undefined),
      fetchNode: vi.fn(async () => {
        throw new Error("unused");
      }),
    };

    const client = createOpenAiUnifiedChatClient({
      getCredential: async () => "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const catalogue = createRangeProfileCatalogue();
    const outcome = await client.turn(
      {
        text: "What are the bluffs for IP in the current node?",
        setupSummary: "test",
        availableProfiles: [],
        draftRevision: 1,
        contextSnapshot: buildAssistantContextSnapshot({
          draft: emptyDraft(),
          draftRevision: 1,
          solutionId: "sol-1",
        }),
      },
      {
        catalogue,
        getDraft: emptyDraft,
        getRevision: () => 1,
        preferences: emptyStudySetupPreferences(),
        evidenceHost,
      },
    );

    expect(outcome.kind).toBe("answer");
    if (outcome.kind === "answer") {
      expect(outcome.message).toContain("7h2d");
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(
      String((fetchImpl.mock.calls[0]?.[1] as RequestInit).body),
    ) as {
      tools: Array<{ function: { name: string } }>;
      tool_choice: unknown;
    };
    expect(firstBody.tools.map((tool) => tool.function.name)).not.toContain(
      "emit_study_setup_proposal",
    );
    expect(firstBody.tool_choice).toBe("auto");
    const secondBody = JSON.parse(
      String((fetchImpl.mock.calls[1]?.[1] as RequestInit).body),
    ) as { messages: Array<{ role: string; content?: string }> };
    expect(secondBody.messages.some((m) => m.role === "tool")).toBe(true);
    const toolMsg = secondBody.messages.find((m) => m.role === "tool");
    expect(() => JSON.parse(String(toolMsg?.content ?? ""))).not.toThrow();
  });

  it("does not force setup or expose the setup tool for how-to setup questions", async () => {
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
                      arguments: JSON.stringify({
                        message: "Open Build, choose CO vs BB SRP, then load 100NL ranges.",
                      }),
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
    const outcome = await client.turn(
      {
        text: "How do I set up CO vs BB SRP with 100NL ranges?",
        setupSummary: "test",
        availableProfiles: [],
        draftRevision: 2,
      },
      {
        catalogue: createRangeProfileCatalogue(),
        getDraft: emptyDraft,
        getRevision: () => 2,
        preferences: emptyStudySetupPreferences(),
      },
    );
    expect(outcome.kind).toBe("answer");
    const body = JSON.parse(String((fetchImpl.mock.calls[0]?.[1] as RequestInit).body)) as {
      tools: Array<{ function: { name: string } }>;
      tool_choice: unknown;
    };
    expect(body.tool_choice).toBe("auto");
    expect(body.tools.map((tool) => tool.function.name)).toEqual(
      expect.arrayContaining(["answer_user", "list_bluff_candidates"]),
    );
    expect(body.tools.map((tool) => tool.function.name)).not.toContain(
      "emit_study_setup_proposal",
    );
  });

  it("rejects an unexpected setup tool on a Q&A turn without mutating Build", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: "emit_study_setup_proposal",
                      arguments: JSON.stringify({
                        kind: "prepare_study",
                        intent: { mode: "create", potType: "3BP" },
                      }),
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
    const draft = emptyDraft();
    const client = createOpenAiUnifiedChatClient({
      getCredential: async () => "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const outcome = await client.turn(
      {
        text: "At this 3BP node, which hands bluff?",
        setupSummary: "test",
        availableProfiles: [],
        draftRevision: 1,
      },
      {
        catalogue: createRangeProfileCatalogue(),
        getDraft: () => draft,
        getRevision: () => 1,
        preferences: emptyStudySetupPreferences(),
      },
    );
    expect(outcome.kind).toBe("answer");
    if (outcome.kind === "answer") {
      expect(outcome.message).toMatch(/change the Build draft|explain how/i);
    }
    expect(draft.pot).toBe(5.5);
  });

  it("forces the setup tool for an explicit set-up command", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: "emit_study_setup_proposal",
                      arguments: JSON.stringify({
                        kind: "prepare_study",
                        intent: { mode: "create", potType: "SRP", oop: "BB", ip: "CO" },
                        stakesLabel: "100NL",
                      }),
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
    const outcome = await client.turn(
      {
        text: "Set up CO vs BB SRP with 100NL ranges.",
        setupSummary: "test",
        availableProfiles: [],
        draftRevision: 1,
      },
      {
        catalogue: createRangeProfileCatalogue(),
        getDraft: emptyDraft,
        getRevision: () => 1,
        preferences: emptyStudySetupPreferences(),
      },
    );
    expect(outcome.kind).toBe("setup");
    const body = JSON.parse(String((fetchImpl.mock.calls[0]?.[1] as RequestInit).body)) as {
      tool_choice: { function?: { name?: string } };
    };
    expect(body.tool_choice?.function?.name).toBe("emit_study_setup_proposal");
  });
});
