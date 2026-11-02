import { describe, expect, it } from "vitest";
import type { ComparePayload } from "../locks";
import type { StatusPayload } from "../types";
import {
  analysisIdentitiesEqual,
  analysisIdentityKey,
  analysisPayloadMatchesNode,
  compareNoteIsValid,
  draftPartialFromStatus,
  resolveBaselineSolutionId,
  shouldClearCompareNote,
  strategyEditScopeFromNode,
  strategyEditScopesEqual,
} from "./identity";

describe("analysis identity", () => {
  it("keys by solution, node, revision, and kind", () => {
    const a = {
      solutionId: "s1",
      nodeId: "root",
      revision: 3,
      kind: "equity" as const,
    };
    const b = { ...a, kind: "runouts" as const };
    expect(analysisIdentityKey(a)).not.toBe(analysisIdentityKey(b));
    expect(analysisIdentitiesEqual(a, { ...a })).toBe(true);
    expect(analysisIdentitiesEqual(a, b)).toBe(false);
  });

  it("rejects foreign node_id on published payloads", () => {
    expect(
      analysisPayloadMatchesNode(
        { node_id: "other", solution_id: "s1" },
        "s1",
        "root",
      ),
    ).toBe(false);
    expect(
      analysisPayloadMatchesNode(
        { node_id: "root", solution_id: "s1" },
        "s1",
        "root",
      ),
    ).toBe(true);
    expect(
      analysisPayloadMatchesNode({ pending: true }, "s1", "root"),
    ).toBe(true);
  });
});

describe("baseline / compare identity", () => {
  it("treats explicit null baseline as clear", () => {
    expect(resolveBaselineSolutionId(null, "s9")).toBe(null);
    expect(resolveBaselineSolutionId(undefined, "s9")).toBe("s9");
    expect(resolveBaselineSolutionId("s2", "s9")).toBe("s2");
  });

  it("validates baseline, scenario, and node before render", () => {
    const note: ComparePayload = {
      baseline_id: "s1",
      scenario_id: "s2",
      node_id: "root",
      baseline_value: 0,
      scenario_value: 0,
      value_delta: 0,
      baseline_nash_gap: 0,
      scenario_nash_gap: 0,
      actions: ["Check"],
      hands: [],
    };
    expect(compareNoteIsValid(note, "s1", "s2", "root")).toBe(true);
    expect(compareNoteIsValid(note, "s1", "s2", "other")).toBe(false);
    expect(compareNoteIsValid(note, null, "s2", "root")).toBe(false);
  });

  it("clears compare when baseline relationship is invalid", () => {
    const note: ComparePayload = {
      baseline_id: "s1",
      scenario_id: "s2",
      node_id: "root",
      baseline_value: 0,
      scenario_value: 0,
      value_delta: 0,
      baseline_nash_gap: 0,
      scenario_nash_gap: 0,
      actions: [],
      hands: [],
    };
    expect(shouldClearCompareNote(note, null, "s2")).toBe(true);
    expect(shouldClearCompareNote(note, "s9", "s2")).toBe(true);
    expect(shouldClearCompareNote(note, "s1", "s2")).toBe(false);
  });
});

describe("strategy edit scope", () => {
  it("changes when player or actions change at the same node id", () => {
    const a = strategyEditScopeFromNode("s1", {
      node_id: "root",
      player: 0,
      actions: ["Check", "Bet 50"],
      combos: ["AcAd", "KcKd"],
    });
    const b = strategyEditScopeFromNode("s1", {
      node_id: "root",
      player: 1,
      actions: ["Check", "Bet 50"],
      combos: ["AcAd", "KcKd"],
    });
    const c = strategyEditScopeFromNode("s1", {
      node_id: "root",
      player: 0,
      actions: ["Check", "Bet 100"],
      combos: ["AcAd", "KcKd"],
    });
    expect(strategyEditScopesEqual(a, a)).toBe(true);
    expect(strategyEditScopesEqual(a, b)).toBe(false);
    expect(strategyEditScopesEqual(a, c)).toBe(false);
  });
});

describe("draftPartialFromStatus", () => {
  it("syncs pot/board/stack so Open does not leave an unrelated Build draft", () => {
    const status = {
      board: ["Kh", "Kd", "7c"],
      pot: 100,
      stack: 200,
      iterations_requested: 40,
      max_raises: 1,
      memory_mib: 64,
      threads: 2,
      algorithm: "cfr_plus",
      samples: 5,
      rake_rate: 0.05,
      rake_cap: 3,
      frozen: true,
      accuracy: -1,
      time_limit: null,
    } as StatusPayload;
    const partial = draftPartialFromStatus(status);
    expect(partial.boardText).toBe("Kh Kd 7c");
    expect(partial.pot).toBe(100);
    expect(partial.stack).toBe(200);
    expect(partial.iterations).toBe(40);
    expect(partial.maxRaises).toBe(1);
    expect(partial.accuracy).toBe("");
    expect(partial.oopRange).toBeUndefined();
    expect(partial.ipRange).toBeUndefined();
  });
});
