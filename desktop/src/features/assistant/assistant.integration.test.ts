import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createAssistantSession,
  createFakeAssistantProvider,
  prepareStudyFromProfile,
} from "../../domain/assistant";
import {
  applySetupTransaction,
  emptyStudySetupPreferences,
  validateSetupForSolve,
} from "../../domain/setup";
import {
  createRangeProfileCatalogue,
  parseRangeProfile,
} from "../../domain/profiles";
import { parseRangeText } from "../../domain/range";
import { DEFAULT_SPOT } from "../../domain/types";

const fixture25 = parseRangeProfile(
  JSON.parse(
    readFileSync(
      "/workspace/configs/range-profiles/fixture-co-bb-srp-100bb-2.5x.json",
      "utf8",
    ),
  ),
);
const fixture25Nl = parseRangeProfile(
  JSON.parse(
    readFileSync(
      "/workspace/configs/range-profiles/fixture-co-bb-srp-100bb-2.5x-100nl.json",
      "utf8",
    ),
  ),
);

describe("assistant → Build transaction integration", () => {
  it("CO vs BB SRP with 100NL applies BB OOP / CO IP ranges with derived pot", async () => {
    const catalogue = createRangeProfileCatalogue([fixture25, fixture25Nl]);
    const session = createAssistantSession();
    let revision = 0;
    let draft = {
      ...DEFAULT_SPOT,
      boardText: "",
      oopRange: "",
      ipRange: "",
    };
    let weights = {
      oop: parseRangeText(""),
      ip: parseRangeText(""),
    };

    const run = await session.run("Set up CO vs BB SRP with 100NL ranges", {
      provider: createFakeAssistantProvider(),
      catalogue,
      getDraft: () => draft,
      getRevision: () => revision,
      preferences: emptyStudySetupPreferences(),
    });

    expect(run.status).toBe("draft");
    expect(run.result).toBeTruthy();
    const result = run.result!;
    expect(result.draftPatch.oopRange).toBe(fixture25Nl.ranges.oop);
    expect(result.draftPatch.ipRange).toBe(fixture25Nl.ranges.ip);
    expect(result.pot).toBeCloseTo(5.5, 10);
    expect(result.stack).toBeCloseTo(97.5, 10);
    expect(result.canSolve).toBe(false);
    expect(result.profile?.classification).toBe("synthetic_fixture");
    expect(result.profile?.id).toBe(fixture25Nl.id);

    const applied = applySetupTransaction({
      currentDraft: draft,
      currentWeights: weights,
      currentMeta: null,
      draftRevision: revision,
      result,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      return;
    }
    draft = applied.draft;
    weights = applied.weights;
    revision = applied.draftRevision;

    expect(draft.oopRange).toContain("AKo:0.5");
    expect(weights.ip[0][0]).toBe(1); // AA from JJ+/pairs in IP open text — JJ+ sets JJ..AA
    // Mixed weight survives
    expect(weights.oop[1][0]).toBeCloseTo(0.5, 8);

    const beforeBoard = validateSetupForSolve(draft);
    expect(beforeBoard.ok).toBe(false);

    draft = { ...draft, boardText: "As 7d 2c" };
    const afterBoard = validateSetupForSolve(draft);
    expect(afterBoard.ok).toBe(true);
  });

  it("prepareStudyFromProfile matches fake NL path quantities", () => {
    const viaDirect = prepareStudyFromProfile(
      fixture25,
      emptyStudySetupPreferences(),
      0,
    );
    expect(viaDirect.pot).toBeCloseTo(5.5, 10);
    expect(viaDirect.stack).toBeCloseTo(97.5, 10);
    expect(viaDirect.draftPatch.oopRange).toBe(fixture25.ranges.oop);
  });

  it("omitted rake assumes cEV catalogue entry", async () => {
    const catalogue = createRangeProfileCatalogue([fixture25, fixture25Nl]);
    const session = createAssistantSession();
    const run = await session.run("Set up CO vs BB SRP", {
      provider: createFakeAssistantProvider(),
      catalogue,
      getDraft: () => ({
        ...DEFAULT_SPOT,
        boardText: "",
        oopRange: "",
        ipRange: "",
      }),
      getRevision: () => 0,
      preferences: emptyStudySetupPreferences(),
    });
    expect(run.status).toBe("draft");
    expect(run.result?.profile?.id).toBe(fixture25.id);
    expect(run.result?.summary.some((line) => /cEV|chip EV/i.test(line))).toBe(
      true,
    );
  });

  it("stale apply after manual edit is rejected", async () => {
    const catalogue = createRangeProfileCatalogue([fixture25]);
    const session = createAssistantSession();
    let revision = 0;
    const draft = { ...DEFAULT_SPOT, boardText: "", oopRange: "", ipRange: "" };
    const run = await session.run("Set up CO vs BB SRP", {
      provider: createFakeAssistantProvider(),
      catalogue,
      getDraft: () => draft,
      getRevision: () => revision,
      preferences: emptyStudySetupPreferences(),
    });
    revision = 1; // player edited while request was conceptually in flight
    const applied = applySetupTransaction({
      currentDraft: draft,
      currentWeights: { oop: parseRangeText(""), ip: parseRangeText("") },
      currentMeta: null,
      draftRevision: revision,
      result: run.result!,
    });
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.reason).toBe("stale");
    }
  });
});
