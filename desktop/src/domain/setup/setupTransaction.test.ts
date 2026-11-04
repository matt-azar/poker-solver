import { describe, expect, it } from "vitest";
import { parseRangeText, snapshotWeights } from "../range";
import { DEFAULT_SPOT } from "../types";
import {
  applySetupTransaction,
  EMPTY_SETUP_META,
  recomputeSetupSolveReadiness,
  undoSetupTransactionGuarded,
} from "./setupTransaction";
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
    expect(applied.undoEntry.changedKeys).toContain("pot");
    expect(applied.undoEntry.beforeDraft.pot).toBe(DEFAULT_SPOT.pot);
    expect(applied.undoEntry.afterDraft.pot).toBe(5.5);
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

  it("A07: rejects negative pot / fractional iterations without mutating draft", () => {
    const current = { ...DEFAULT_SPOT, pot: 100, iterations: 200 };
    const weights = snapshotWeights({
      oop: parseRangeText(current.oopRange),
      ip: parseRangeText(current.ipRange),
    });
    const applied = applySetupTransaction({
      currentDraft: current,
      currentWeights: weights,
      currentMeta: null,
      draftRevision: 0,
      result: result({
        ok: true,
        canSolve: false,
        draftPatch: { pot: -5, iterations: 12.5 },
      }),
    });
    expect(applied.ok).toBe(false);
    if (applied.ok) {
      return;
    }
    expect(applied.reason).toBe("blocked");
    expect(applied.message).toMatch(/Pot|Iterations/i);
  });

  it("create mode does not keep prior boardText or solutionPath from the live draft", () => {
    const live = {
      ...DEFAULT_SPOT,
      boardText: "Ah Kd 7c 4s 2h",
      solutionPath: "/old/study.bin",
      pot: 100,
      stack: 200,
      iterations: 999,
    };
    const applied = applySetupTransaction({
      currentDraft: live,
      currentWeights: snapshotWeights({
        oop: parseRangeText(live.oopRange),
        ip: parseRangeText(live.ipRange),
      }),
      currentMeta: null,
      draftRevision: 0,
      result: result({
        mode: "create",
        draftPatch: {
          boardText: "",
          oopRange: "QQ+",
          ipRange: "JJ+",
          pot: 5.5,
          stack: 97.5,
          solutionPath: "",
        },
        pot: 5.5,
        stack: 97.5,
        missing: [
          {
            field: "board",
            message: "Select a flop, turn, or river board before solving",
            reason: "board_missing",
          },
        ],
        canSolve: false,
      }),
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      return;
    }
    expect(applied.draft.boardText).toBe("");
    expect(applied.draft.solutionPath).toBe("");
    expect(applied.draft.pot).toBe(5.5);
    expect(applied.draft.stack).toBe(97.5);
    // Create starts from blank defaults, not leftover live iterations.
    expect(applied.draft.iterations).toBe(DEFAULT_SPOT.iterations);
  });

  it("edit mode preserves unrelated live draft fields", () => {
    const live = {
      ...DEFAULT_SPOT,
      boardText: "As 7d 2c",
      pot: 12,
      stack: 88,
      iterations: 400,
      solutionPath: "/keep/me.bin",
    };
    const applied = applySetupTransaction({
      currentDraft: live,
      currentWeights: snapshotWeights({
        oop: parseRangeText(live.oopRange),
        ip: parseRangeText(live.ipRange),
      }),
      currentMeta: null,
      draftRevision: 1,
      result: result({
        mode: "edit",
        requestRevision: 1,
        draftPatch: { pot: 5.5 },
        pot: 5.5,
      }),
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      return;
    }
    expect(applied.draft.pot).toBe(5.5);
    expect(applied.draft.stack).toBe(88);
    expect(applied.draft.boardText).toBe("As 7d 2c");
    expect(applied.draft.iterations).toBe(400);
    expect(applied.draft.solutionPath).toBe("/keep/me.bin");
    expect(applied.undoEntry.changedKeys).toEqual(["pot"]);
  });
});

describe("undoSetupTransactionGuarded (A05)", () => {
  it("undo pot edit after manual stack change keeps the later stack", () => {
    const weights = snapshotWeights({
      oop: parseRangeText(DEFAULT_SPOT.oopRange),
      ip: parseRangeText(DEFAULT_SPOT.ipRange),
    });
    const applied = applySetupTransaction({
      currentDraft: { ...DEFAULT_SPOT, pot: 100, stack: 200 },
      currentWeights: weights,
      currentMeta: null,
      draftRevision: 0,
      result: result({
        mode: "edit",
        draftPatch: { pot: 5.5 },
        pot: 5.5,
      }),
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      return;
    }

    // User manually changes stack after the assistant pot edit.
    const afterManual = {
      ...applied.draft,
      stack: 777,
    };
    const undone = undoSetupTransactionGuarded({
      currentDraft: afterManual,
      currentWeights: applied.weights,
      currentMeta: applied.meta,
      draftRevision: applied.draftRevision + 1,
      entry: applied.undoEntry,
    });

    expect(undone.draft.pot).toBe(100);
    expect(undone.draft.stack).toBe(777);
    expect(undone.restoredKeys).toContain("pot");
    // Stack was never an assistant-owned key, so no conflict — just preserved.
    expect(undone.conflictKeys).toEqual([]);
    expect(undone.message).toMatch(/Reverted assistant setup/i);
  });

  it("undo with no intervening edits fully restores assistant fields", () => {
    const weights = snapshotWeights({
      oop: parseRangeText("AA"),
      ip: parseRangeText("KK"),
    });
    const before = {
      ...DEFAULT_SPOT,
      pot: 100,
      stack: 200,
      boardText: "As 7d 2c",
      oopRange: "AA",
      ipRange: "KK",
    };
    const applied = applySetupTransaction({
      currentDraft: before,
      currentWeights: weights,
      currentMeta: null,
      draftRevision: 2,
      result: result({
        mode: "edit",
        requestRevision: 2,
        draftPatch: { pot: 5.5, stack: 97.5, oopRange: "QQ+", ipRange: "JJ+" },
        pot: 5.5,
        stack: 97.5,
      }),
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      return;
    }

    const undone = undoSetupTransactionGuarded({
      currentDraft: applied.draft,
      currentWeights: applied.weights,
      currentMeta: applied.meta,
      draftRevision: applied.draftRevision,
      entry: applied.undoEntry,
    });

    expect(undone.draft.pot).toBe(100);
    expect(undone.draft.stack).toBe(200);
    expect(undone.draft.oopRange).toBe("AA");
    expect(undone.draft.ipRange).toBe("KK");
    expect(undone.conflictKeys).toEqual([]);
    expect(undone.message).toMatch(/Reverted assistant setup/i);
  });

  it("partial undo restores pot but keeps a later overwrite of stack", () => {
    const applied = applySetupTransaction({
      currentDraft: { ...DEFAULT_SPOT, pot: 100, stack: 200 },
      currentWeights: snapshotWeights({
        oop: parseRangeText(DEFAULT_SPOT.oopRange),
        ip: parseRangeText(DEFAULT_SPOT.ipRange),
      }),
      currentMeta: null,
      draftRevision: 0,
      result: result({
        mode: "edit",
        draftPatch: { pot: 5.5, stack: 97.5 },
        pot: 5.5,
        stack: 97.5,
      }),
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      return;
    }

    const afterManual = { ...applied.draft, stack: 777 };
    const undone = undoSetupTransactionGuarded({
      currentDraft: afterManual,
      currentWeights: applied.weights,
      currentMeta: applied.meta,
      draftRevision: applied.draftRevision,
      entry: applied.undoEntry,
    });

    expect(undone.draft.pot).toBe(100);
    expect(undone.draft.stack).toBe(777);
    expect(undone.restoredKeys).toContain("pot");
    expect(undone.conflictKeys).toContain("stack");
    expect(undone.message).toMatch(/Reverted pot/i);
    expect(undone.message).toMatch(/kept later edits to stack/i);
  });

  it("skips fields overwritten after apply and explains the conflict", () => {
    const applied = applySetupTransaction({
      currentDraft: { ...DEFAULT_SPOT, pot: 10, stack: 100 },
      currentWeights: snapshotWeights({
        oop: parseRangeText(DEFAULT_SPOT.oopRange),
        ip: parseRangeText(DEFAULT_SPOT.ipRange),
      }),
      currentMeta: null,
      draftRevision: 0,
      result: result({
        mode: "edit",
        draftPatch: { pot: 5.5, stack: 97.5 },
        pot: 5.5,
        stack: 97.5,
      }),
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      return;
    }

    const overwritten = { ...applied.draft, pot: 42, stack: 777 };
    const undone = undoSetupTransactionGuarded({
      currentDraft: overwritten,
      currentWeights: applied.weights,
      currentMeta: applied.meta,
      draftRevision: applied.draftRevision,
      entry: applied.undoEntry,
    });

    expect(undone.draft.pot).toBe(42);
    expect(undone.draft.stack).toBe(777);
    expect(undone.restoredKeys).toEqual([]);
    expect(undone.conflictKeys).toEqual(expect.arrayContaining(["pot", "stack"]));
    expect(undone.message).toMatch(/Could not revert/i);
  });
});

describe("recomputeSetupSolveReadiness", () => {
  it("returns null when there is no setup meta", () => {
    expect(recomputeSetupSolveReadiness(null, { ...DEFAULT_SPOT })).toBeNull();
  });

  it("clears board_missing and canSolve after a manual board completes the draft", () => {
    const incomplete = {
      ...DEFAULT_SPOT,
      boardText: "",
      oopRange: "JJ+,AKs",
      ipRange: "QQ+",
      pot: 5.5,
      stack: 97.5,
    };
    const meta = {
      ...EMPTY_SETUP_META,
      provenance: { boardText: "unresolved" as const, pot: "derived" as const },
      missing: [
        {
          field: "board",
          message: "Select a flop, turn, or river board before solving",
          reason: "board_missing",
        },
      ],
      canSolve: false,
      summary: ["Missing board"],
    };

    const stillBlocked = recomputeSetupSolveReadiness(meta, incomplete);
    expect(stillBlocked?.canSolve).toBe(false);
    expect(stillBlocked?.missing.some((m) => m.reason === "board_missing")).toBe(
      true,
    );

    const completed = {
      ...incomplete,
      boardText: "As 7d 2c",
    };
    const ready = recomputeSetupSolveReadiness(meta, completed);
    expect(ready?.canSolve).toBe(true);
    expect(ready?.missing.some((m) => m.reason === "board_missing")).toBe(false);
    expect(ready?.provenance.boardText).toBe("manual");
  });
});
