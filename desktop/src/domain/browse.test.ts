import { describe, expect, it } from "vitest";
import {
  frequencyOf,
  groupEv,
  groupHands,
  nextGeneration,
  shouldApply,
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

  it("keeps zero-mass EV undefined", () => {
    const node = {
      reach_defined: true,
      actions: ["Check", "Bet 50"],
      combos: ["AhAd", "KhKd"],
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

  it("gates stale fetches and generations", () => {
    expect(shouldApply(3, 3, "s1", "s1")).toBe(true);
    expect(shouldApply(2, 3, "s1", "s1")).toBe(false);
    expect(nextGeneration({ status_generation: 4 }, 4)).toBe(4);
    expect(nextGeneration({ status_generation: 3 }, 4)).toBeNull();
    expect(solutionNeedsReload({ running: false, solution_id: "s2" }, "s1", false)).toBe(true);
    expect(solutionNeedsReload({ running: false, solution_id: "s1" }, "s1", true)).toBe(true);
    expect(solutionNeedsReload({ running: true, solution_id: "s2" }, "s1", false)).toBe(false);
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
