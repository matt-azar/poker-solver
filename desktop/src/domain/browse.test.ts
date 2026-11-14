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
  withEvBasis,
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

  it("flop unit-weight reach keeps inclusion ~1; 1/n deal mass stays near-flat (ZR-121)", () => {
    // Grid + combo inspector both derive height from rangeInclusionOf / raw reach.
    const flopUnit = {
      node_id: "p0.t-1.r-1",
      kind: "decision" as const,
      reach_defined: true,
      actions: ["Check"],
      combos: ["AsAc", "QsQh", "JsJh"],
      reach: [1, 1, 1],
      marginal: [1 / 3, 1 / 3, 1 / 3],
      strategy: [[1], [1], [1]],
    };
    expect(rangeInclusionOf(cellOf(flopUnit, "AA"))).toBeCloseTo(1, 12);
    expect(rangeInclusionOf(cellOf(flopUnit, "QQ"))).toBeCloseTo(1, 12);
    expect(rangeInclusionOf(cellOf(flopUnit, "JJ"))).toBeCloseTo(1, 12);
    const meanUnit =
      flopUnit.reach.reduce((a, b) => a + b, 0) / flopUnit.reach.length;
    expect(meanUnit).toBeCloseTo(1, 12);

    const flopDeal = {
      ...flopUnit,
      reach: [1 / 3, 1 / 3, 1 / 3],
    };
    const meanDeal =
      flopDeal.reach.reduce((a, b) => a + b, 0) / flopDeal.reach.length;
    expect(meanDeal).toBeLessThan(0.4);
    expect(rangeInclusionOf(cellOf(flopDeal, "AA"))!).toBeLessThan(0.4);
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

  it("applies local_offset at Check/Bet nodes when Fold is not legal", () => {
    const node = {
      reach_defined: true,
      actions: ["Check", "Bet 50"],
      combos: ["AhAd"],
      reach: [1],
      marginal: [1],
      strategy: [[0.5, 0.5]],
      node_id: "open",
    };
    const values = {
      node_id: "open",
      utility_basis: "root_centered",
      local_offset: 50,
      actions: ["Check", "Bet 50"],
      combos: ["AhAd"],
      ev_defined: [true],
      value: [0],
      action_ev: [[-10, 10]],
      node_ev: 0,
    };
    const aa = cellOf(node, "AA");
    const local = groupEv(node, values, aa, "local");
    expect(local?.action[0]).toBeCloseTo(40, 12);
    expect(local?.action[1]).toBeCloseTo(60, 12);
    expect(local?.mixed).toBeCloseTo(50, 12);
    const global = groupEv(node, values, aa, "root_centered");
    expect(global?.action[0]).toBeCloseTo(-10, 12);
    expect(global?.mixed).toBeCloseTo(0, 12);
  });

  it("indexes Fold from values.actions even when node action labels omit Fold", () => {
    const values = {
      node_id: "facing",
      utility_basis: "root_centered",
      local_offset: 50,
      actions: ["Fold", "Call"],
      combos: ["AhAd"],
      ev_defined: [true],
      value: [-50],
      action_ev: [[-50, -25]],
      node_ev: -50,
    };
    // Node labels without Fold must not prevent local conversion — action_ev
    // columns follow values.actions.
    const localized = withEvBasis(values, "local", ["Call", "Raise 100"]);
    expect(localized?.utility_basis).toBe("local");
    expect(localized?.action_ev?.[0]?.[0]).toBeCloseTo(0, 12);
    expect(localized?.action_ev?.[0]?.[1]).toBeCloseTo(25, 12);
    expect(localized?.value?.[0]).toBeCloseTo(0, 12);
    expect(localized?.node_ev).toBeCloseTo(0, 12);
  });

  it("uses Zig local primary columns without client shift", () => {
    const values = {
      node_id: "facing",
      utility_basis: "local",
      local_offset: 50,
      actions: ["Fold", "Call"],
      combos: ["AhAd"],
      ev_defined: [true],
      value: [0],
      action_ev: [[0, 25]],
      node_ev: 0,
      root_centered: {
        action_ev: [[-50, -25]],
        value: [-50],
        node_ev: -50,
      },
    };
    const local = withEvBasis(values, "local");
    expect(local).toBe(values);
    expect(local?.action_ev?.[0]?.[0]).toBeCloseTo(0, 12);
    expect(local?.action_ev?.[0]?.[1]).toBeCloseTo(25, 12);

    const global = withEvBasis(values, "root_centered");
    expect(global?.utility_basis).toBe("root_centered");
    expect(global?.action_ev?.[0]?.[0]).toBeCloseTo(-50, 12);
    expect(global?.action_ev?.[0]?.[1]).toBeCloseTo(-25, 12);
    expect(global?.value?.[0]).toBeCloseTo(-50, 12);
    expect(global?.node_ev).toBeCloseTo(-50, 12);
  });

  it("selects dual root columns for flop Check/Bet Zig local payloads", () => {
    // Flop roots have no Fold; Zig already applied local_offset on primary columns.
    const node = {
      reach_defined: true,
      actions: ["Check", "Bet 50"],
      combos: ["AsAc"],
      reach: [1],
      marginal: [1],
      strategy: [[0.5, 0.5]],
      node_id: "flop-root",
    };
    const values = {
      node_id: "flop-root",
      utility_basis: "local",
      local_offset: 50,
      actions: ["Check", "Bet 50"],
      combos: ["AsAc"],
      ev_defined: [true],
      value: [50],
      action_ev: [[40, 60]],
      node_ev: 50,
      root_centered: {
        action_ev: [[-10, 10]],
        value: [0],
        node_ev: 0,
      },
    };
    const aa = cellOf(node, "AA");
    const local = groupEv(node, values, aa, "local");
    expect(local?.action[0]).toBeCloseTo(40, 12);
    expect(local?.action[1]).toBeCloseTo(60, 12);
    expect(local?.mixed).toBeCloseTo(50, 12);
    const global = groupEv(node, values, aa, "root_centered");
    expect(global?.action[0]).toBeCloseTo(-10, 12);
    expect(global?.action[1]).toBeCloseTo(10, 12);
    expect(global?.mixed).toBeCloseTo(0, 12);
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

  it("colors Call all-in green like Call, not red like All-in", () => {
    const colors = mapActionColors(["Fold", "Call all-in", "All-in", "Call"]);
    expect(actionIdentity("Call all-in")).toBe("call");
    expect(colors.byLabel["Call all-in"]).toBe(colors.byLabel["Call"]);
    expect(colors.byLabel["Call all-in"]).toBe("#3F8F6B");
    expect(colors.byLabel["Call all-in"]).not.toBe(colors.byLabel["All-in"]);
    expect(colors.byLabel["All-in"]).toBe("#5A0F18");
  });
});
