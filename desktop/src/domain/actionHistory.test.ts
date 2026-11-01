import { describe, expect, it } from "vitest";
import {
  formatChoiceFrequency,
  lineCrumbs,
  nextChoicesFromNode,
  splitActionLine,
} from "./actionHistory";
import type { NodePayload } from "./types";

describe("actionHistory helpers", () => {
  it("splits engine line paths into crumbs", () => {
    expect(splitActionLine("open")).toEqual([]);
    expect(splitActionLine("Check/Bet 50/Call")).toEqual([
      "Check",
      "Bet 50",
      "Call",
    ]);
    expect(lineCrumbs("Check/Bet 50", "root-1")).toEqual([
      { label: "Root", nodeId: "root-1" },
      { label: "Check" },
      { label: "Bet 50" },
    ]);
  });

  it("pairs actions with child ids and strategy frequencies", () => {
    const node: NodePayload = {
      node_id: "n1",
      kind: "decision",
      player: 0,
      actions: ["Check", "Bet 50"],
      children: ["n-check", "n-bet"],
      combos: ["AsAh", "KsKh"],
      marginal: [1, 1],
      reach_defined: true,
      strategy: [
        [0.25, 0.75],
        [0.25, 0.75],
      ],
    };
    const choices = nextChoicesFromNode(node);
    expect(choices).toHaveLength(2);
    expect(choices[0]).toMatchObject({
      label: "Check",
      nodeId: "n-check",
      kind: "action",
    });
    expect(choices[1]?.nodeId).toBe("n-bet");
    expect(choices[0]?.frequency).toBeCloseTo(0.25, 8);
    expect(choices[1]?.frequency).toBeCloseTo(0.75, 8);
    expect(formatChoiceFrequency(0.753)).toBe("75%");
  });

  it("reads chance cards from the cards field", () => {
    const node: NodePayload = {
      node_id: "c0",
      kind: "chance",
      cards: [
        { card: "As", child_id: "n1", weight: 0.02 },
        { card: "2h", child_id: "n2", weight: 0.02 },
      ],
    };
    const choices = nextChoicesFromNode(node);
    expect(choices.map((choice) => choice.label)).toEqual(["As", "2h"]);
    expect(choices[0]?.nodeId).toBe("n1");
  });
});
