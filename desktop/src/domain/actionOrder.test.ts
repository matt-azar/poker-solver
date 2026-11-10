import { describe, expect, it } from "vitest";
import {
  actionAggressionScore,
  compareActionsAggressiveFirst,
  orderActionIndicesByAggression,
} from "./actionOrder";

describe("actionAggressionScore", () => {
  it("ranks all-in above sized bets, then call/check/fold", () => {
    expect(actionAggressionScore("All-in")).toBeGreaterThan(
      actionAggressionScore("Bet 100"),
    );
    expect(actionAggressionScore("b137")).toBeGreaterThan(
      actionAggressionScore("Check"),
    );
    expect(actionAggressionScore("Call")).toBeGreaterThan(
      actionAggressionScore("Check"),
    );
    expect(actionAggressionScore("Check")).toBeGreaterThan(
      actionAggressionScore("Fold"),
    );
    expect(actionAggressionScore("Call all-in")).toBe(
      actionAggressionScore("Call"),
    );
    expect(actionAggressionScore("All-in")).toBeGreaterThan(
      actionAggressionScore("Call all-in"),
    );
  });

  it("orders larger pot tags as more aggressive", () => {
    expect(actionAggressionScore("b100")).toBeGreaterThan(
      actionAggressionScore("b50"),
    );
    expect(actionAggressionScore("Raise 200")).toBeGreaterThan(
      actionAggressionScore("Bet 50"),
    );
  });
});

describe("orderActionIndicesByAggression", () => {
  it("puts passive actions first for left-to-right paint", () => {
    const actions = ["Check", "b36", "b137"];
    expect(orderActionIndicesByAggression(actions)).toEqual([0, 1, 2]);
  });

  it("is stable for the comparator used by sort", () => {
    const actions = ["Fold", "Call", "Bet 75", "All-in"];
    const ordered = [...actions].sort(compareActionsAggressiveFirst);
    expect(ordered).toEqual(["All-in", "Bet 75", "Call", "Fold"]);
  });
});
