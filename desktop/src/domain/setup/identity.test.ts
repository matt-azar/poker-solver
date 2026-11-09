import { describe, expect, it } from "vitest";
import type { ComparePayload } from "../locks";
import type { StatusPayload } from "../types";
import {
  analysisIdentitiesEqual,
  analysisIdentityKey,
  analysisPayloadMatchesNode,
  analysisErrorIsPermanent,
  analysisPayloadNeedsAutoload,
  analysisPayloadReady,
  compareNoteIsValid,
  draftFromOpenedSolution,
  draftPartialFromSolutionConfig,
  draftPartialFromStatus,
  openDraftBase,
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

  it("treats settled errors as not ready so auto-load can retry", () => {
    expect(
      analysisPayloadReady(
        { pending: false, error: "equity work limit exceeded", node_id: "root" },
        "s1",
        "root",
      ),
    ).toBe(false);
    expect(
      analysisPayloadReady(
        { pending: false, node_id: "root", oop_equity: 0.5 },
        "s1",
        "root",
      ),
    ).toBe(true);
  });

  it("keeps work-limit errors settled without auto-resubmit", () => {
    expect(analysisErrorIsPermanent("equity work limit exceeded")).toBe(true);
    expect(analysisErrorIsPermanent("temporary failure")).toBe(false);
    expect(
      analysisPayloadNeedsAutoload(
        {
          pending: false,
          error: "equity work limit exceeded",
          node_id: "root",
          solution_id: "s1",
        },
        "s1",
        "root",
      ),
    ).toBe(false);
    expect(
      analysisPayloadNeedsAutoload(
        { pending: false, error: "temporary failure", node_id: "root", solution_id: "s1" },
        "s1",
        "root",
      ),
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
    expect(partial.timeLimit).toBe("");
    expect(partial.oopRange).toBeUndefined();
    expect(partial.ipRange).toBeUndefined();
  });

  it("clears timeLimit when status time_limit is null", () => {
    const partial = draftPartialFromStatus({
      time_limit: null,
    } as StatusPayload);
    expect(partial.timeLimit).toBe("");
  });
});

describe("openDraftBase / draftFromOpenedSolution", () => {
  it("starts with empty ranges and bets so prior Build paint cannot leak", () => {
    const base = openDraftBase("/tmp/aa.psol");
    expect(base.oopRange).toBe("");
    expect(base.ipRange).toBe("");
    expect(base.oopBets).toBe("");
    expect(base.ipBets).toBe("");
    expect(base.oopFlop).toBe("");
    expect(base.treeEdits).toEqual([]);
    expect(base.timeLimit).toBe("");
    expect(base.solutionPath).toBe("/tmp/aa.psol");
  });

  it("replaces draft wholesale from config so 22s do not survive over AA", () => {
    const opened = draftFromOpenedSolution({
      solutionPath: "/tmp/aa.psol",
      status: {
        board: ["Ah", "Kd", "7c", "4s", "2h"],
        pot: 100,
        stack: 200,
        time_limit: null,
        accuracy: -1,
        iterations_requested: 200,
      } as StatusPayload,
      config: {
        kind: "street",
        board: ["Ah", "Kd", "7c", "4s", "2h"],
        pot: 100,
        stack: 200,
        oop_range: "AA",
        ip_range: "KK",
        oop_bets: [0.5, 1],
        ip_bets: [0.5],
        oop_flop_bets: [0.5],
        ip_flop_bets: [],
        oop_turn_bets: [],
        ip_turn_bets: [],
        oop_river_bets: [1],
        ip_river_bets: [1],
        tree_edits: ["force - c"],
        time_limit: null,
      },
    });
    expect(opened.configComplete).toBe(true);
    expect(opened.warnings).toEqual([]);
    expect(opened.draft.oopRange).toBe("AA");
    expect(opened.draft.ipRange).toBe("KK");
    expect(opened.draft.oopBets).toBe("50, 100");
    // Empty ip_flop_bets inherits shared ip_bets [0.5].
    expect(opened.draft.ipFlop).toBe("50");
    expect(opened.draft.treeEdits).toEqual(["force - c"]);
    expect(opened.draft.timeLimit).toBe("");
    expect(opened.draft.solutionPath).toBe("/tmp/aa.psol");
  });

  it("clears ranges/bets when config is missing instead of merging a stale draft", () => {
    const opened = draftFromOpenedSolution({
      solutionPath: "/tmp/other.psol",
      status: {
        board: ["Kh", "Kd", "7c"],
        pot: 50,
        stack: 100,
        time_limit: null,
      } as StatusPayload,
      config: null,
    });
    expect(opened.configComplete).toBe(false);
    expect(opened.warnings.length).toBeGreaterThan(0);
    expect(opened.draft.oopRange).toBe("");
    expect(opened.draft.ipRange).toBe("");
    expect(opened.draft.oopBets).toBe("");
    expect(opened.draft.boardText).toBe("Kh Kd 7c");
    expect(opened.draft.pot).toBe(50);
    expect(opened.draft.timeLimit).toBe("");
  });

  it("resolves inherited street bets into Build text; explicit-empty stays blank", () => {
    const inherited = draftPartialFromSolutionConfig({
      oop_bets: [0.5, 1],
      ip_bets: [0.5],
      oop_flop_bets: [],
      ip_flop_bets: [],
      oop_turn_bets: [-4e9],
      ip_turn_bets: [-4e9],
      oop_flop_raises: [],
      ip_flop_raises: [],
    });
    expect(inherited.oopBets).toBe("50, 100");
    expect(inherited.oopFlop).toBe("50, 100");
    expect(inherited.ipFlop).toBe("50");
    expect(inherited.oopTurn).toBe("");
    expect(inherited.ipTurn).toBe("");
    expect(inherited.oopFlopRaises).toBe("-");
    expect(inherited.allowAllIn).toBeUndefined();

    const withAllInFlag = draftPartialFromSolutionConfig({
      allow_all_in: true,
      oop_bets: [0.5],
      ip_bets: [0.5],
    });
    expect(withAllInFlag.allowAllIn).toBe(true);
    const withoutAllInFlag = draftPartialFromSolutionConfig({
      allow_all_in: false,
      oop_bets: [0.5],
      ip_bets: [0.5],
    });
    expect(withoutAllInFlag.allowAllIn).toBe(false);

    const checkOnly = draftPartialFromSolutionConfig({
      oop_bets: [],
      ip_bets: [],
      oop_flop_bets: [],
      ip_flop_bets: [],
    });
    expect(checkOnly.oopBets).toBe("");
    expect(checkOnly.oopFlop).toBe("");
    expect(checkOnly.ipFlop).toBe("");
  });
});
