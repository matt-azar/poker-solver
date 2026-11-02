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
import { commitAssistantSetup } from "../../features/help/commitAssistantSetup";

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
    expect(unified).toContain("contextSnapshot");
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
      analysisTools?: { deferred?: string[] };
    };
    expect(userPayload.contextSnapshot?.version).toBe(1);
    expect(userPayload.analysisTools?.deferred).toContain("compare_runouts");
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
});
