import { describe, expect, it } from "vitest";
import { createRangeProfileCatalogue } from "../profiles";
import { emptyStudySetupPreferences } from "../setup";
import { DEFAULT_SPOT } from "../types";
import { validateGeneratedRanges } from "./generatedRanges";
import { resolveAssistantProposal } from "./resolve";

describe("validateGeneratedRanges", () => {
  it("accepts parseable paired weights", () => {
    const result = validateGeneratedRanges({
      oop: "22+,AKs,AKo:0.5",
      ip: "88+,AQs+,AKo",
      note: "demo",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.oopCombos).toBeGreaterThan(1);
      expect(result.note).toBe("demo");
    }
  });

  it("rejects empty grids", () => {
    const result = validateGeneratedRanges({ oop: "not-a-hand", ip: "zzz" });
    expect(result.ok).toBe(false);
  });
});

describe("resolveAssistantProposal generated + interpolated", () => {
  const prefs = emptyStudySetupPreferences();
  const catalogue = createRangeProfileCatalogue([]);

  it("applies guarded generated ranges with model_generated provenance", () => {
    const result = resolveAssistantProposal({
      proposal: {
        kind: "prepare_study",
        intent: {
          mode: "create",
          potType: "SRP",
          oopPosition: "BB",
          ipPosition: "CO",
          stackBb: 100,
          board: "As 7d 2c",
        },
        board: "As 7d 2c",
        generatedRanges: {
          oop: "22+,AKs",
          ip: "99+,AQs+,AKo",
          note: "unit test generation",
        },
      },
      baseDraft: { ...DEFAULT_SPOT },
      catalogue,
      preferences: prefs,
      draftRevision: 3,
    });
    expect(result.draftPatch.oopRange).toContain("AKs");
    expect(result.provenance.oopRange).toBe("model_generated");
    expect(result.provenance.ipRange).toBe("model_generated");
    expect(result.profile?.classification).toBe("model_generated");
    expect(result.summary.join(" ")).toMatch(/not equilibrium|model-generated/i);
  });

  it("interpolates two imported stack refs", () => {
    const low = {
      schemaVersion: 1,
      id: "pack-150",
      dataRevision: "1",
      displayName: "150",
      format: "cash_6max",
      playerCount: 6,
      positions: { oop: "BB", ip: "CO" },
      preflopActions: [
        { position: "CO", kind: "open" as const, sizeBb: 2.5 },
        { position: "BB", kind: "call" as const, sizeBb: 1.5 },
      ],
      startingStackBb: 150,
      blinds: { sb: 0.5, bb: 1 },
      rake: { rate: 0, cap: 0, collection: "none", known: true },
      labels: { stakes: "cEV" },
      ranges: { oop: "AA,KK", ip: "AA" },
      provenance: {
        source: "test",
        classification: "equilibrium_model" as const,
      },
    };
    const high = {
      ...low,
      id: "pack-200",
      displayName: "200",
      startingStackBb: 200,
      ranges: { oop: "AA,KK,QQ", ip: "AA,KK" },
    };
    const cat = createRangeProfileCatalogue([low, high]);
    const result = resolveAssistantProposal({
      proposal: {
        kind: "prepare_study",
        intent: {
          mode: "create",
          potType: "SRP",
          oopPosition: "BB",
          ipPosition: "CO",
          stackBb: 175,
          stakesLabel: "cEV",
          board: "As 7d 2c",
        },
        board: "As 7d 2c",
        interpolateFromIds: ["pack-150", "pack-200"],
        stackBb: 175,
      },
      baseDraft: { ...DEFAULT_SPOT },
      catalogue: cat,
      preferences: prefs,
      draftRevision: 4,
    });
    expect(result.provenance.oopRange).toBe("interpolated");
    expect(result.profile?.classification).toBe("interpolated");
    expect(result.summary.join(" ")).toMatch(/interpolat/i);
  });
});
