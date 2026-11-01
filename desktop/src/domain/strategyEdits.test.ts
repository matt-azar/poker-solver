import { describe, expect, it } from "vitest";
import { editForNode, isHandEdited } from "./strategyEdits";

describe("strategy edit helpers", () => {
  it("finds edits by node and marks full-node hands as edited", () => {
    const edits = [
      {
        node_id: "p0.t-1.r-1",
        kind: "selected" as const,
        hand_indices: [0, 2],
        probs: [0, 1],
      },
      {
        node_id: "p1.t-1.r-1",
        kind: "full" as const,
        hand_indices: [],
        probs: [1, 0],
      },
    ];
    expect(editForNode(edits, "p0.t-1.r-1")?.hand_indices).toEqual([0, 2]);
    expect(isHandEdited(editForNode(edits, "p0.t-1.r-1"), 2)).toBe(true);
    expect(isHandEdited(editForNode(edits, "p0.t-1.r-1"), 1)).toBe(false);
    expect(isHandEdited(editForNode(edits, "p1.t-1.r-1"), 9)).toBe(true);
  });
});
