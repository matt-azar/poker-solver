import { describe, expect, it, vi } from "vitest";
import type { SetupDraftResult } from "../../domain/setup";
import { commitAssistantSetup } from "./commitAssistantSetup";

function proposal(revision: number): SetupDraftResult {
  return {
    ok: true,
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

describe("commitAssistantSetup", () => {
  it("applies once with the original proposal and without force", () => {
    const result = proposal(2);
    const applySetupDraft = vi.fn(() => ({ ok: true as const }));

    const outcome = commitAssistantSetup(result, applySetupDraft);

    expect(outcome).toEqual({ ok: true });
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
