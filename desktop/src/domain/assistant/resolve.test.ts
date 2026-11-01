import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createBlankSetupDraft,
  emptyStudySetupPreferences,
} from "../setup";
import {
  createRangeProfileCatalogue,
  parseRangeProfileDocument,
} from "../profiles";
import { DEFAULT_SPOT, type SpotDraft } from "../types";
import {
  FakeAssistantProvider,
  catalogueProfileMetas,
  prepareStudyFromProfile,
  profileToMeta,
  resolveAssistantProposal,
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
const fixture25Nl = parseRangeProfileDocument(
  readFileSync(
    join(
      here,
      "../../../../configs/range-profiles/fixture-co-bb-srp-100bb-2.5x-100nl.json",
    ),
    "utf8",
  ),
);
const fixture3x = parseRangeProfileDocument(
  readFileSync(
    join(
      here,
      "../../../../configs/range-profiles/fixture-co-bb-srp-100bb-3x.json",
    ),
    "utf8",
  ),
);

describe("resolveAssistantProposal", () => {
  const catalogue = createRangeProfileCatalogue([
    fixture25,
    fixture25Nl,
    fixture3x,
  ]);
  const prefs = emptyStudySetupPreferences();
  const provider = new FakeAssistantProvider();

  it("CO vs BB SRP cEV → BB OOP / CO IP ranges, pot 5.5, stack 97.5, canSolve false without board", async () => {
    const proposal = await provider.interpret({
      text: "Set up CO vs BB SRP",
      setupSummary: "",
      availableProfiles: catalogueProfileMetas(catalogue),
      capabilities: ["prepare_study"],
      draftRevision: 3,
    });
    expect(proposal.kind).toBe("prepare_study");

    const result = resolveAssistantProposal({
      proposal,
      baseDraft: createBlankSetupDraft("create"),
      catalogue,
      preferences: prefs,
      draftRevision: 3,
    });

    expect(result.draftPatch.oopRange).toBe(fixture25.ranges.oop);
    expect(result.draftPatch.ipRange).toBe(fixture25.ranges.ip);
    expect(result.pot).toBeCloseTo(5.5, 10);
    expect(result.stack).toBeCloseTo(97.5, 10);
    expect(result.canSolve).toBe(false);
    expect(result.missing.some((m) => m.field === "board")).toBe(true);
    expect(
      result.summary.some(
        (line) =>
          /synthetic/i.test(line) ||
          /fixture/i.test(line) ||
          line.includes(fixture25.displayName),
      ),
    ).toBe(true);
    expect(result.summary.some((line) => /cEV|chip EV/i.test(line))).toBe(true);
    expect(result.summary.some((line) => /100bb starting/i.test(line))).toBe(
      true,
    );
    expect(result.profile?.id).toBe(fixture25.id);
    expect(result.requestRevision).toBe(3);
  });

  it("100NL SRP path matches the 100NL-labelled catalogue entry", async () => {
    const proposal = await provider.interpret({
      text: "Set up CO vs BB SRP with 100NL ranges",
      setupSummary: "",
      availableProfiles: catalogueProfileMetas(catalogue),
      capabilities: ["prepare_study"],
      draftRevision: 4,
    });
    expect(proposal.kind).toBe("prepare_study");
    const result = resolveAssistantProposal({
      proposal,
      baseDraft: createBlankSetupDraft("create"),
      catalogue,
      preferences: prefs,
      draftRevision: 4,
    });
    expect(result.profile?.id).toBe(fixture25Nl.id);
    expect(result.pot).toBeCloseTo(5.5, 10);
    expect(result.stack).toBeCloseTo(97.5, 10);
  });

  it("100NL alone does not set 100bb without positions/pot type", async () => {
    const clarify = await provider.interpret({
      text: "100NL",
      setupSummary: "",
      availableProfiles: catalogueProfileMetas(catalogue),
      capabilities: ["prepare_study"],
      draftRevision: 1,
    });
    expect(clarify.kind).toBe("clarify");
    const clarified = resolveAssistantProposal({
      proposal: clarify,
      baseDraft: createBlankSetupDraft("create"),
      catalogue,
      preferences: prefs,
      draftRevision: 1,
    });
    expect(clarified.ok).toBe(false);
    expect(clarified.canSolve).toBe(false);
    expect(clarified.draftPatch.stack).toBeUndefined();

    // With fixture match, remaining stack comes from profile derivation — not from "100NL"≡100bb.
    const prepared = resolveAssistantProposal({
      proposal: {
        kind: "prepare_study",
        intent: {
          mode: "create",
          oopPosition: "BB",
          ipPosition: "CO",
          potType: "SRP",
          stakesLabel: "100NL",
          stackBb: 100,
          profileQuery: fixture25Nl.id,
        },
        selectedProfileId: fixture25Nl.id,
        stakesLabel: "100NL",
        stackBb: 100,
      },
      baseDraft: createBlankSetupDraft("create"),
      catalogue,
      preferences: prefs,
      draftRevision: 2,
    });
    expect(prepared.stack).toBeCloseTo(97.5, 10);
    expect(
      prepared.summary.some((line) => /does not set stack/i.test(line)),
    ).toBe(true);
  });

  it("board update preserves existing ranges", async () => {
    const base: SpotDraft = {
      ...DEFAULT_SPOT,
      boardText: "",
      oopRange: fixture25.ranges.oop,
      ipRange: fixture25.ranges.ip,
      pot: 5.5,
      stack: 97.5,
    };
    const proposal = await provider.interpret({
      text: "Change the flop to As 7d 2c",
      setupSummary: "CO vs BB loaded",
      availableProfiles: [profileToMeta(fixture25)],
      capabilities: ["update_study"],
      draftRevision: 4,
    });
    const result = resolveAssistantProposal({
      proposal,
      baseDraft: base,
      catalogue,
      preferences: prefs,
      draftRevision: 4,
    });
    expect(result.draftPatch.boardText).toBe("As 7d 2c");
    // Edit mode: unspecified ranges stay on the live base (not wiped).
    expect(result.draftPatch.oopRange).toBeUndefined();
    expect(result.draftPatch.ipRange).toBeUndefined();
    expect(base.oopRange).toBe(fixture25.ranges.oop);
    expect(base.ipRange).toBe(fixture25.ranges.ip);
  });

  it("unsupported and unrelated proposals produce incomplete drafts", () => {
    const unsupported = resolveAssistantProposal({
      proposal: { kind: "unsupported", message: "no strategy essays" },
      baseDraft: createBlankSetupDraft("create"),
      catalogue,
      preferences: prefs,
      draftRevision: 1,
    });
    expect(unsupported.ok).toBe(false);
    expect(unsupported.canSolve).toBe(false);
    expect(unsupported.missing[0]?.reason).toBe("unsupported");

    const unrelated = resolveAssistantProposal({
      proposal: { kind: "unrelated", message: "not poker" },
      baseDraft: createBlankSetupDraft("create"),
      catalogue,
      preferences: prefs,
      draftRevision: 1,
    });
    expect(unrelated.ok).toBe(false);
    expect(unrelated.missing[0]?.reason).toBe("unrelated");
  });

  it("duplicate at 150bb conflicts when profile starting stack differs", () => {
    const base: SpotDraft = {
      ...DEFAULT_SPOT,
      oopRange: fixture25.ranges.oop,
      ipRange: fixture25.ranges.ip,
      pot: 5.5,
      stack: 97.5,
    };
    const result = resolveAssistantProposal({
      proposal: {
        kind: "duplicate_study",
        intent: { mode: "duplicate", stackBb: 150 },
        selectedProfileId: fixture25.id,
        stackBb: 150,
      },
      baseDraft: base,
      catalogue,
      preferences: prefs,
      draftRevision: 9,
    });
    expect(result.conflicts.some((c) => c.field === "stack")).toBe(true);
    expect(result.canSolve).toBe(false);
  });

  it("tree edit applies IP flop bets", async () => {
    const base: SpotDraft = {
      ...DEFAULT_SPOT,
      oopRange: "AA",
      ipRange: "KK",
      ipFlop: "",
    };
    const proposal = await provider.interpret({
      text: "Use 33% and 75% flop bets for IP",
      setupSummary: "",
      availableProfiles: [],
      capabilities: ["update_study"],
      draftRevision: 1,
    });
    const result = resolveAssistantProposal({
      proposal,
      baseDraft: base,
      catalogue,
      preferences: prefs,
      draftRevision: 1,
    });
    expect(result.draftPatch.ipFlop).toBe("0.33, 0.75");
  });
});

describe("prepareStudyFromProfile", () => {
  it("direct path loads fixture ranges and derived pot/stack", () => {
    const result = prepareStudyFromProfile(
      fixture25,
      emptyStudySetupPreferences(),
      7,
    );
    expect(result.draftPatch.oopRange).toBe(fixture25.ranges.oop);
    expect(result.draftPatch.ipRange).toBe(fixture25.ranges.ip);
    expect(result.pot).toBeCloseTo(5.5, 10);
    expect(result.stack).toBeCloseTo(97.5, 10);
    expect(result.canSolve).toBe(false);
    expect(result.requestRevision).toBe(7);
    expect(result.summary.some((line) => /synthetic/i.test(line))).toBe(true);
  });

  it("optional board enables canSolve when ranges present", () => {
    const result = prepareStudyFromProfile(
      fixture25,
      emptyStudySetupPreferences(),
      8,
      "As 7d 2c",
    );
    expect(result.draftPatch.boardText).toBe("As 7d 2c");
    expect(result.canSolve).toBe(true);
    expect(result.ok).toBe(true);
  });
});
