import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  bumpRevision,
  createBlankSetupDraft,
  emptyStudySetupPreferences,
  initialRevision,
} from "../setup";
import {
  createRangeProfileCatalogue,
  parseRangeProfileDocument,
} from "../profiles";
import type { SpotDraft } from "../types";
import {
  FakeAssistantProvider,
  createAssistantSession,
  type AssistantProvider,
  type InterpretProposal,
  type InterpretRequest,
} from "./index";

const here = dirname(fileURLToPath(import.meta.url));
const fixture25 = parseRangeProfileDocument(
  readFileSync(
    join(
      here,
      "../../../../configs/range-profiles/fixture-co-bb-srp-100bb-2.5x.json",
    ),
    "utf8",
  ),
);

describe("createAssistantSession", () => {
  const catalogue = createRangeProfileCatalogue([fixture25]);
  const prefs = emptyStudySetupPreferences();

  it("returns a draft result for CO vs BB setup", async () => {
    const session = createAssistantSession();
    let draft = createBlankSetupDraft("create");
    let revision = initialRevision(1);

    const run = await session.run("Set up CO vs BB using my 100NL profile", {
      provider: new FakeAssistantProvider(),
      catalogue,
      getDraft: () => draft,
      getRevision: () => revision,
      preferences: prefs,
    });

    expect(run.status).toBe("draft");
    expect(run.result?.pot).toBeCloseTo(5.5, 10);
    expect(run.result?.stack).toBeCloseTo(97.5, 10);
    expect(run.result?.canSolve).toBe(false);
    expect(run.requestRevision).toBe(1);
    // Session does not apply — caller owns the transaction.
    expect(draft.oopRange).toBe("");
  });

  it("reports stale when revision changes during interpret", async () => {
    const session = createAssistantSession();
    let revision = 10;
    const slow: AssistantProvider = {
      async interpret(request: InterpretRequest): Promise<InterpretProposal> {
        revision = bumpRevision(revision);
        return new FakeAssistantProvider().interpret(request);
      },
    };

    const run = await session.run("Set up CO vs BB SRP", {
      provider: slow,
      catalogue,
      getDraft: () => createBlankSetupDraft("create"),
      getRevision: () => revision,
      preferences: prefs,
    });

    expect(run.status).toBe("stale");
    expect(run.requestRevision).toBe(10);
  });

  it("cancels via AbortSignal", async () => {
    const session = createAssistantSession();
    const controller = new AbortController();
    const slow: AssistantProvider = {
      async interpret(request: InterpretRequest): Promise<InterpretProposal> {
        controller.abort();
        // Simulate work completing after abort was signaled.
        await Promise.resolve();
        return new FakeAssistantProvider().interpret(request);
      },
    };

    const run = await session.run("Set up CO vs BB", {
      provider: slow,
      catalogue,
      getDraft: () => createBlankSetupDraft("create"),
      getRevision: () => 1,
      preferences: prefs,
      signal: controller.signal,
    });

    expect(run.status).toBe("cancelled");
  });

  it("cancels via session.cancel()", async () => {
    const session = createAssistantSession();
    let resolveInterpret!: (value: InterpretProposal) => void;
    const gate = new Promise<InterpretProposal>((resolve) => {
      resolveInterpret = resolve;
    });
    const blocked: AssistantProvider = {
      interpret() {
        return gate;
      },
    };

    const pending = session.run("Set up CO vs BB", {
      provider: blocked,
      catalogue,
      getDraft: () => createBlankSetupDraft("create"),
      getRevision: () => 1,
      preferences: prefs,
    });

    expect(session.inFlightRunId()).not.toBeNull();
    session.cancel();
    resolveInterpret({
      kind: "unrelated",
      message: "should be ignored after cancel",
    });
    const run = await pending;
    expect(run.status).toBe("cancelled");
  });

  it("surfaces unsupported and unrelated statuses", async () => {
    const session = createAssistantSession();
    const provider = new FakeAssistantProvider();
    const draft: SpotDraft = createBlankSetupDraft("create");

    const unsupported = await session.run("explain GTO strategy", {
      provider,
      catalogue,
      getDraft: () => draft,
      getRevision: () => 1,
      preferences: prefs,
    });
    expect(unsupported.status).toBe("unsupported");

    const unrelated = await session.run("lorem ipsum dolor sit", {
      provider,
      catalogue,
      getDraft: () => draft,
      getRevision: () => 1,
      preferences: prefs,
    });
    expect(unrelated.status).toBe("unrelated");
  });

  it("allocates distinct run ids so retries do not share identity", async () => {
    const session = createAssistantSession();
    const provider = new FakeAssistantProvider();
    const a = await session.run("asdf gibberish", {
      provider,
      catalogue,
      getDraft: () => createBlankSetupDraft("create"),
      getRevision: () => 1,
      preferences: prefs,
    });
    const b = await session.run("asdf gibberish", {
      provider,
      catalogue,
      getDraft: () => createBlankSetupDraft("create"),
      getRevision: () => 1,
      preferences: prefs,
    });
    expect(a.runId).not.toBe(b.runId);
  });
});
