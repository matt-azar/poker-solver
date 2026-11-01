import { describe, expect, it } from "vitest";
import { parseRangeText, snapshotWeights } from "../range";
import { DEFAULT_SPOT } from "../types";
import { applySetupTransaction, EMPTY_SETUP_META } from "./setupTransaction";
import type { SetupDraftResult } from "./types";

function result(partial: Partial<SetupDraftResult> & { draftPatch: SetupDraftResult["draftPatch"] }): SetupDraftResult {
  return {
    ok: true,
    provenance: {},
    conflicts: [],
    missing: [],
    summary: ["test"],
    canSolve: false,
    requestRevision: 0,
    ...partial,
  };
}

describe("applySetupTransaction", () => {
  it("applies pot/stack/ranges as one undoable snapshot", () => {
    const weights = {
      oop: parseRangeText(DEFAULT_SPOT.oopRange),
      ip: parseRangeText(DEFAULT_SPOT.ipRange),
    };
    const draftResult = result({
      draftPatch: {
        boardText: "",
        oopRange: "AKo:0.5,QQ+",
        ipRange: "JJ+,AKs",
        pot: 5.5,
        stack: 97.5,
      },
      pot: 5.5,
      stack: 97.5,
      profile: {
        id: "fixture-co-bb-srp-100bb-2.5x",
        revision: 1,
        displayName: "FIXTURE",
        classification: "synthetic_fixture",
      },
      provenance: { pot: "derived", stack: "derived" },
    });

    const applied = applySetupTransaction({
      currentDraft: { ...DEFAULT_SPOT },
      currentWeights: weights,
      currentMeta: null,
      draftRevision: 0,
      result: draftResult,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      return;
    }
    expect(applied.draft.pot).toBe(5.5);
    expect(applied.draft.stack).toBe(97.5);
    expect(applied.draft.oopRange).toContain("AKo:0.5");
    expect(applied.weights.oop[1][0]).toBeCloseTo(0.5, 8); // AKo (offsuit)
    expect(applied.meta.profile?.id).toBe("fixture-co-bb-srp-100bb-2.5x");
    expect(applied.draftRevision).toBe(1);
    expect(applied.undoSnapshot.draft.oopRange).toBe(DEFAULT_SPOT.oopRange);
  });

  it("rejects stale proposals without mutation", () => {
    const applied = applySetupTransaction({
      currentDraft: { ...DEFAULT_SPOT },
      currentWeights: snapshotWeights({
        oop: parseRangeText("AA"),
        ip: parseRangeText("KK"),
      }),
      currentMeta: EMPTY_SETUP_META,
      draftRevision: 3,
      result: result({
        requestRevision: 2,
        draftPatch: { pot: 9 },
      }),
    });
    expect(applied.ok).toBe(false);
    if (applied.ok) {
      return;
    }
    expect(applied.reason).toBe("stale");
  });

  it("blocks on conflicts unless forced", () => {
    const base = {
      currentDraft: { ...DEFAULT_SPOT },
      currentWeights: snapshotWeights({
        oop: parseRangeText("AA"),
        ip: parseRangeText("KK"),
      }),
      currentMeta: null,
      draftRevision: 0,
      result: result({
        ok: false,
        conflicts: [{ field: "stack", message: "Explicit stack conflicts with profile" }],
        draftPatch: { stack: 150 },
      }),
    };
    const blocked = applySetupTransaction(base);
    expect(blocked.ok).toBe(false);
    const forced = applySetupTransaction({ ...base, force: true });
    expect(forced.ok).toBe(true);
  });
});
