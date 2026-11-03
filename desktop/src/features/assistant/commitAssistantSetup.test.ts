import { describe, expect, it, vi } from "vitest";
import { blankGrid } from "../../domain/range";
import { DEFAULT_SPOT } from "../../domain/types";
import type { SetupDraftResult } from "../../domain/setup";
import type { SetupUndoEntry } from "../../domain/setup";
import { commitAssistantSetup } from "./commitAssistantSetup";

function proposal(revision: number): SetupDraftResult {
  return {
    ok: true,
    mode: "edit",
    draftPatch: { pot: 5.5 },
    pot: 5.5,
    provenance: {},
    conflicts: [],
    missing: [],
    summary: ["test"],
    canSolve: false,
    requestRevision: revision,
  };
}

function undoEntry(revision: number): SetupUndoEntry {
  return {
    operationId: `setup-${revision + 1}-1`,
    mode: "edit",
    changedKeys: ["pot"],
    beforeDraft: { pot: 100 },
    afterDraft: { pot: 5.5 },
    rangesChanged: false,
    beforeWeights: null,
    afterWeights: null,
    beforeMeta: null,
    afterMeta: {
      profile: null,
      rangeSnapshot: null,
      profileDataRevision: null,
      provenance: {},
      summary: ["test"],
      conflicts: [],
      missing: [],
      canSolve: false,
    },
    baseRevision: revision,
    resultRevision: revision + 1,
    fullBefore: {
      draft: { ...DEFAULT_SPOT, pot: 100 },
      weights: { oop: blankGrid(), ip: blankGrid() },
      meta: null,
      draftRevision: revision,
    },
  };
}

describe("commitAssistantSetup", () => {
  it("applies once and returns a receipt from the undo entry", () => {
    const result = proposal(2);
    const entry = undoEntry(2);
    const applySetupDraft = vi.fn(() => ({ ok: true as const, undoEntry: entry }));

    const outcome = commitAssistantSetup(result, applySetupDraft);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.receipt.operationId).toBe(entry.operationId);
    expect(outcome.receipt.changedFields).toEqual([
      { field: "pot", before: 100, after: 5.5 },
    ]);
    expect(applySetupDraft).toHaveBeenCalledTimes(1);
    expect(applySetupDraft).toHaveBeenCalledWith(result);
    expect(applySetupDraft.mock.calls[0][1]?.force).toBeUndefined();
  });

  it("surfaces stale rejection without reminting revision or force-retrying", () => {
    const result = proposal(2);
    const stale = {
      ok: false as const,
      reason: "stale",
      message: "Setup changed while the assistant ran — regenerate the proposal",
    };
    const applySetupDraft = vi.fn(() => stale);

    const outcome = commitAssistantSetup(result, applySetupDraft);

    expect(outcome).toEqual(stale);
    expect(applySetupDraft).toHaveBeenCalledTimes(1);
    expect(applySetupDraft).toHaveBeenCalledWith(result);
    const passed = applySetupDraft.mock.calls[0][0];
    expect(passed.requestRevision).toBe(2);
    expect(applySetupDraft.mock.calls[0][1]?.force).toBeUndefined();
  });

  it("does not force-apply when the transaction reports conflicts", () => {
    const result: SetupDraftResult = {
      ...proposal(0),
      ok: false,
      conflicts: [{ field: "stack", message: "Explicit stack conflicts with profile" }],
      draftPatch: { stack: 150 },
    };
    const blocked = {
      ok: false as const,
      reason: "blocked",
      message: "Explicit stack conflicts with profile",
    };
    const applySetupDraft = vi.fn(() => blocked);

    expect(commitAssistantSetup(result, applySetupDraft)).toEqual(blocked);
    expect(applySetupDraft).toHaveBeenCalledTimes(1);
    expect(applySetupDraft.mock.calls[0][1]?.force).toBeUndefined();
  });
});
