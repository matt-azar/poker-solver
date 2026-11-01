import { describe, expect, it } from "vitest";
import { DEFAULT_SPOT, type SpotDraft } from "../types";
import {
  assertRevision,
  createBlankSetupDraft,
  isStaleProposal,
  mergeSetupPatch,
  validateSetupForSolve,
} from "./apply";
import { derivePostflopPotAndStacks } from "./derive";
import { bumpRevision, initialRevision } from "./revision";

function dirtyPriorStudy(): SpotDraft {
  return {
    ...DEFAULT_SPOT,
    boardText: "As Kh 2c",
    oopRange: "JJ+,AKs",
    ipRange: "TT+,AQs+,AKo",
    pot: 12,
    stack: 88,
  };
}

describe("createBlankSetupDraft", () => {
  it("create mode does not inherit prior board or ranges", () => {
    const prior = dirtyPriorStudy();
    const blank = createBlankSetupDraft("create", prior);
    expect(blank.boardText).toBe("");
    expect(blank.oopRange).toBe("");
    expect(blank.ipRange).toBe("");
    expect(blank.solutionPath).toBe("");
  });

  it("duplicate keeps board and ranges from the source", () => {
    const prior = dirtyPriorStudy();
    const copy = createBlankSetupDraft("duplicate", prior);
    expect(copy.boardText).toBe(prior.boardText);
    expect(copy.oopRange).toBe(prior.oopRange);
    expect(copy.ipRange).toBe(prior.ipRange);
    expect(copy.solutionPath).toBe("");
  });
});

describe("mergeSetupPatch", () => {
  it("marks missing board as incomplete and canSolve false", () => {
    const base = createBlankSetupDraft("create");
    const derived = derivePostflopPotAndStacks({
      startingStackBb: 100,
      openSizeBb: 2.5,
    });
    const result = mergeSetupPatch(
      base,
      {
        mode: "create",
        explicitFields: {
          oopRange: "22+,A2s+,KTo+",
          ipRange: "77+,ATs+,KJo+",
        },
        derived: { potBb: derived.potBb, stackBb: derived.stackBb },
        requestRevision: 1,
      },
    );
    expect(result.missing.some((item) => item.field === "board")).toBe(true);
    expect(result.canSolve).toBe(false);
    expect(result.draftPatch.pot).toBeCloseTo(5.5, 10);
    expect(result.draftPatch.stack).toBeCloseTo(97.5, 10);
  });

  it("does not set stack from a 100NL rake/stakes label alone", () => {
    const base = createBlankSetupDraft("create");
    const result = mergeSetupPatch(base, {
      mode: "create",
      explicitFields: { stakesLabel: "100NL" },
      requestRevision: 2,
    });
    expect(result.provenance.stakesLabel).toBe("explicit_request");
    expect(result.provenance.stack).not.toBe("explicit_request");
    expect(result.summary.some((line) => /does not set stack/i.test(line))).toBe(
      true,
    );
    expect(
      result.summary.some((line) => /rake\/stakes environment/i.test(line)),
    ).toBe(true);
  });

  it("records an explicit vs profile stack conflict and keeps the requested stack", () => {
    const base = createBlankSetupDraft("create");
    const result = mergeSetupPatch(base, {
      mode: "create",
      explicitFields: { stackBb: 150 },
      profileFields: { stackBb: 100 },
      profile: {
        id: "co-bb-srp-100nl",
        revision: 3,
        displayName: "CO vs BB 100NL",
        classification: "population",
      },
      requestRevision: 4,
    });
    expect(result.conflicts.some((item) => item.field === "stack")).toBe(true);
    expect(result.canSolve).toBe(false);
    expect(result.draftPatch.stack).toBe(150);
    expect(result.ok).toBe(false);
  });

  it("prefers explicit board over profile when they agree path-wise", () => {
    const base = createBlankSetupDraft("edit", dirtyPriorStudy());
    const result = mergeSetupPatch(base, {
      mode: "edit",
      explicitFields: { boardText: "Ah Kd 7c" },
      profileFields: {
        oopRange: "QQ+",
        ipRange: "KK+",
        stackBb: 100,
      },
      derived: { potBb: 5.5, stackBb: 97.5 },
      requestRevision: 5,
    });
    expect(result.conflicts).toEqual([]);
    expect(result.draftPatch.boardText).toBe("Ah Kd 7c");
    expect(result.provenance.boardText).toBe("explicit_request");
    expect(result.provenance.oopRange).toBe("selected_profile");
    expect(result.canSolve).toBe(true);
  });

  it("applies saved stack preference when nothing else supplies stack", () => {
    const base = createBlankSetupDraft("create");
    const result = mergeSetupPatch(
      base,
      {
        mode: "create",
        explicitFields: {
          boardText: "As 7d 2c",
          oopRange: "AA",
          ipRange: "KK",
        },
        derived: { potBb: 5.5 },
        requestRevision: 6,
      },
      { defaultStackBb: 100 },
    );
    expect(result.draftPatch.stack).toBe(100);
    expect(result.provenance.stack).toBe("saved_preference");
    expect(result.canSolve).toBe(true);
  });
});

describe("revision protection", () => {
  it("detects stale proposals", () => {
    let revision = initialRevision(0);
    revision = bumpRevision(revision);
    expect(isStaleProposal(0, revision)).toBe(true);
    expect(isStaleProposal(revision, revision)).toBe(false);
    expect(() => assertRevision(1, 2)).toThrow(/stale/i);
    expect(() => assertRevision(3, 3)).not.toThrow();
  });
});

describe("validateSetupForSolve", () => {
  it("rejects empty board and empty ranges", () => {
    const draft = createBlankSetupDraft("create");
    const result = validateSetupForSolve(draft);
    expect(result.ok).toBe(false);
    expect(result.errors.some((line) => /board/i.test(line))).toBe(true);
    expect(result.errors.some((line) => /OOP range/i.test(line))).toBe(true);
  });

  it("accepts a complete flop draft", () => {
    const draft: SpotDraft = {
      ...DEFAULT_SPOT,
      boardText: "Ah Kd 7c",
      oopRange: "AA,KK",
      ipRange: "QQ+",
      pot: 5.5,
      stack: 97.5,
    };
    expect(validateSetupForSolve(draft)).toEqual({ ok: true, errors: [] });
  });
});
