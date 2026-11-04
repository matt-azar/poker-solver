import { describe, expect, it } from "vitest";
import {
  acceptStatusGeneration,
  formatRangeInclusion,
  frequencyOf,
  groupEv,
  groupHands,
  hasWithinHandActionMixing,
  isExcludedMatrixCell,
  isPartialRangeDisplay,
  nextGeneration,
opponentSolutionNode,
  RANGE_INCLUSION_MEASURE,
  rangeDisplayWeight,
  rangeInclusionOf,
  shouldApply,
  shouldApplyScoped,
  shouldApplyStatus,
  solutionNeedsReload,
  strategyMix,
} from "./browse";
import { createRangeHistory, snapshotWeights, blankGrid } from "./range";
import { mapActionColors, actionIdentity } from "./actionColors";

function cellOf(node: Parameters<typeof groupHands>[0], text: string) {
  const cell = groupHands(node).find((item) => item.text === text);
  expect(cell).toBeTruthy();
  return cell!;
}

describe("browse strategy grouping", () => {
  it("weights mixed aggression and per-action frequencies", () => {
    const mixed = {
      reach_defined: true,
      actions: ["Check", "Bet 50", "Bet 100"],
      combos: ["AhAd"],
      reach: [1],
      marginal: [1],
      strategy: [[0.2, 0.3, 0.5]],
      node_id: "p00.t-1.r-1",
    };
    const mixedCell = cellOf(mixed, "AA");
    expect(frequencyOf(mixedCell, "aggression")).toBeCloseTo(0.8, 12);
    expect(frequencyOf(mixedCell, "0")).toBeCloseTo(0.2, 12);
    expect(strategyMix(mixedCell)).toEqual([0.2, 0.3, 0.5]);

    const weighted = {
      reach_defined: true,
      actions: ["Check", "Bet 50", "Bet 100"],
      combos: ["AhAd", "AsAc"],
      reach: [0.25, 0.75],
      marginal: [0.25, 0.75],
      strategy: [
        [0.2, 0.3, 0.5],
        [0, 0, 1],
      ],
      node_id: "p00.t-1.r-1",
    };
    const weightedCell = cellOf(weighted, "AA");
    expect(weightedCell.marginalSum).toBe(1);
    expect(frequencyOf(weightedCell, "1")).toBeCloseTo(0.075, 12);
    expect(frequencyOf(weightedCell, "2")).toBeCloseTo(0.875, 12);
    expect(frequencyOf(weightedCell, "aggression")).toBeCloseTo(0.95, 12);
  });

  it("Range mode inclusion uses reach, not average posterior marginal", () => {
    // AA-only: three combos each reach=1, posterior marginal=1/3.
    // Old UI showed 33 (mean posterior); inclusion weight must be 100.
    const node = {
      reach_defined: true,
      actions: ["Check"],
      combos: ["AhAd", "AsAc", "AsAh"],
      reach: [1, 1, 1],
      marginal: [1 / 3, 1 / 3, 1 / 3],
      strategy: [[1], [1], [1]],
      node_id: "aa-only",
    };
    const aa = cellOf(node, "AA");
    expect(aa.marginalSum).toBeCloseTo(1, 12);
    expect(aa.reachSum).toBeCloseTo(3, 12);
    expect(aa.marginalSum / aa.range_combos).toBeCloseTo(1 / 3, 12);
    expect(rangeInclusionOf(aa)).toBeCloseTo(1, 12);
    expect(formatRangeInclusion(rangeInclusionOf(aa)!)).toBe("100");
    expect(RANGE_INCLUSION_MEASURE).toBe("inclusion weight");
  });

  it("opponentSolutionNode reuses opponent_reach for inclusion (not posterior)", () => {
    // Acting AA at 100% reach; opponent KK with reach=1 but marginal=1/3.
    // Old opponent pane showed KK33 via marginalSum/range_combos; must be 100.
    const node = {
      node_id: "decision",
      player: 0,
      reach_defined: true,
      actions: ["Check"],
      combos: ["AhAd"],
      reach: [1],
      marginal: [1],
      strategy: [[1]],
      opponent_player: 1,
      opponent_combos: ["KhKd", "KsKc", "KsKh"],
      opponent_reach: [1, 1, 1],
      opponent_marginal: [1 / 3, 1 / 3, 1 / 3],
    };
    const view = opponentSolutionNode(node);
    expect(view).not.toBeNull();
    expect(view!.player).toBe(1);
    expect(view!.reach).toEqual([1, 1, 1]);
    expect(view!.marginal).toEqual([1 / 3, 1 / 3, 1 / 3]);
    const kk = cellOf(view!, "KK");
    expect(kk.marginalSum / kk.range_combos).toBeCloseTo(1 / 3, 12);
    expect(rangeInclusionOf(kk)).toBeCloseTo(1, 12);
    expect(formatRangeInclusion(rangeInclusionOf(kk)!)).toBe("100");
  });

  it("opponentSolutionNode returns null without solution opponent_reach", () => {
    expect(
      opponentSolutionNode({
        node_id: "x",
        opponent_player: 1,
        opponent_combos: ["AhAd"],
      }),
    ).toBeNull();
    expect(opponentSolutionNode(null)).toBeNull();
  });

  it("keeps zero-mass EV undefined", () => {
    const node = {
      reach_defined: true,
      actions: ["Check", "Bet 50"],
      combos: ["AhAd", "KhKd"],
      reach: [1, 0],
      marginal: [1, 0],
      strategy: [
        [0.5, 0.5],
        [1, 0],
      ],
      node_id: "n1",
    };
    const values = {
      node_id: "n1",
      combos: ["AhAd", "KhKd"],
      ev_defined: [true, true],
      value: [1, 9],
      action_ev: [
        [0, 2],
        [8, 10],
      ],
    };
    const aa = cellOf(node, "AA");
    const kk = cellOf(node, "KK");
    expect(groupEv(node, values, aa)?.mixed).toBeCloseTo(1, 12);
    expect(groupEv(node, values, kk)).toBeNull();
  });

  it("defaults to local EV so Fold displays as 0", () => {
    const node = {
      reach_defined: true,
      actions: ["Fold", "Call"],
      combos: ["AhAd"],
      reach: [1],
      marginal: [1],
      strategy: [[0.5, 0.5]],
      node_id: "facing",
    };
    const values = {
      node_id: "facing",
      utility_basis: "root_centered",
      local_offset: 50,
      actions: ["Fold", "Call"],
      combos: ["AhAd"],
      ev_defined: [true],
      value: [-50],
      action_ev: [[-50, -50]],
      node_ev: -50,
    };
    const aa = cellOf(node, "AA");
    const local = groupEv(node, values, aa, "local");
    expect(local?.action[0]).toBeCloseTo(0, 12);
    expect(local?.action[1]).toBeCloseTo(0, 12);
    expect(local?.mixed).toBeCloseTo(0, 12);
    const global = groupEv(node, values, aa, "root_centered");
    expect(global?.action[0]).toBeCloseTo(-50, 12);
    expect(global?.mixed).toBeCloseTo(-50, 12);
  });

  it("flags excluded, partial range weight, and action mixing visually", () => {
    const node = {
      reach_defined: true,
      actions: ["Check", "Bet 50"],
      combos: ["AhAd", "AsAc", "KhKd"],
      marginal: [0.5, 0.5, 0],
      strategy: [
        [0.5, 0.5],
        [1, 0],
        [1, 0],
      ],
      node_id: "n-density",
    };
    const aa = cellOf(node, "AA");
    const kk = cellOf(node, "KK");
    expect(isExcludedMatrixCell(kk)).toBe(true);
    expect(isExcludedMatrixCell(aa)).toBe(false);
    expect(rangeDisplayWeight(aa)).toBeCloseTo(0.5, 12);
    expect(isPartialRangeDisplay(aa)).toBe(true);
    expect(hasWithinHandActionMixing(aa)).toBe(true);
    expect(hasWithinHandActionMixing(cellOf({
      ...node,
      combos: ["AhAd"],
      marginal: [1],
      strategy: [[1, 0]],
    }, "AA"))).toBe(false);
    expect(rangeDisplayWeight(kk)).toBe(0);
    expect(isPartialRangeDisplay(kk)).toBe(false);
  });

  it("gates stale fetches and generations", () => {
    expect(shouldApply(3, 3, "s1", "s1")).toBe(true);
    expect(shouldApply(2, 3, "s1", "s1")).toBe(false);
    expect(shouldApply(3, 3, "s1", null)).toBe(false);
    expect(shouldApply(3, 3, null, "s1")).toBe(false);
    expect(nextGeneration({ status_generation: 4 }, 4)).toBe(4);
    expect(nextGeneration({ status_generation: 3 }, 4)).toBeNull();
    expect(acceptStatusGeneration({ status_generation: 4 }, 4)).toEqual({
      apply: true,
      generation: 4,
      restarted: false,
    });
    expect(acceptStatusGeneration({ status_generation: 3 }, 4)).toEqual({
      apply: false,
      reason: "stale",
    });
    expect(
      acceptStatusGeneration({ status_generation: 0 }, 9, { allowRestart: true }),
    ).toEqual({ apply: true, generation: 0, restarted: true });
    expect(acceptStatusGeneration({}, 1)).toEqual({
      apply: false,
      reason: "missing",
    });
    expect(shouldApplyStatus(2, 2)).toBe(true);
    expect(shouldApplyStatus(1, 2)).toBe(false);
    expect(solutionNeedsReload({ running: false, solution_id: "s2" }, "s1", false)).toBe(true);
    expect(solutionNeedsReload({ running: false, solution_id: "s1" }, "s1", true)).toBe(true);
    expect(solutionNeedsReload({ running: true, solution_id: "s2" }, "s1", false)).toBe(false);
  });

  it("shouldApplyScoped fails closed on node mismatch after await", () => {
    expect(
      shouldApplyScoped({
        token: 1,
        latestToken: 1,
        requestSolutionId: "s1",
        liveSolutionId: "s1",
        requestNodeId: "p0",
        liveNodeId: "p0",
      }),
    ).toBe(true);
    expect(
      shouldApplyScoped({
        token: 1,
        latestToken: 1,
        requestSolutionId: "s1",
        liveSolutionId: "s1",
        requestNodeId: "p0",
        liveNodeId: "p1",
      }),
    ).toBe(false);
    expect(
      shouldApplyScoped({
        token: 1,
        latestToken: 2,
        requestSolutionId: "s1",
        liveSolutionId: "s1",
        requestNodeId: "p0",
        liveNodeId: "p0",
      }),
    ).toBe(false);
  });
});

describe("range history", () => {
  it("undoes and refuses duplicate pushes", () => {
    const history = createRangeHistory(3);
    const a = { oop: blankGrid(), ip: blankGrid() };
    a.oop[0][0] = 1;
    expect(history.push(snapshotWeights(a))).toBe(true);
    expect(history.push(snapshotWeights(a))).toBe(false);
    const current = { oop: blankGrid(), ip: blankGrid() };
    current.oop[1][1] = 1;
    const previous = history.undo(current);
    expect(previous?.oop[0][0]).toBe(1);
    expect(history.canRedo()).toBe(true);
  });
});

describe("action colors", () => {
  it("keeps identity stable across order changes", () => {
    const first = mapActionColors(["Check", "Bet 50", "Bet 100", "All-in"]);
    const second = mapActionColors(["Bet 100", "Check", "All-in", "Bet 50"]);
    expect(first.byLabel["Bet 50"]).toBe(second.byLabel["Bet 50"]);
    expect(first.byLabel["Bet 100"]).toBe(second.byLabel["Bet 100"]);
    expect(actionIdentity("Bet 50%")).toBe(actionIdentity("Bet 50%"));
    expect(first.byLabel["All-in"]).not.toBe(first.byLabel["Bet 50"]);
  });
});
