import { describe, expect, it } from "vitest";
import { boardBlockers, chanceCardOptions, fullDeckGrid, parseCardCode } from "./cards";
import type { NodePayload } from "./types";

describe("card helpers", () => {
  it("parses card codes and board blockers", () => {
    expect(parseCardCode("Ah")).toEqual({ rank: "A", suit: "h" });
    expect([...boardBlockers(["Ah", "Kd"])].sort()).toEqual(["Ah", "Kd"]);
  });

  it("builds chance options and a full deck grid", () => {
    const node: NodePayload = {
      node_id: "c0",
      kind: "chance",
      board: ["Ah", "Kd", "7c"],
      children: [
        { card: "As", node_id: "n1", weight: 0.02 },
        { card: "2h", node_id: "n2", weight: 0.02 },
      ],
    };
    const options = chanceCardOptions(node);
    expect(options).toHaveLength(2);
    const grid = fullDeckGrid(options, node.board);
    expect(grid).toHaveLength(52);
    const as = grid.find((cell) => cell.card === "As");
    expect(as && !("missing" in as)).toBe(true);
    const ah = grid.find((cell) => cell.card === "Ah");
    expect(ah && "missing" in ah && ah.blocked).toBe(true);
  });
});
