import { describe, expect, it } from "vitest";
import {
  editForNode,
  isHandEdited,
  strategyMutationCompletion,
} from "./strategyEdits";

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

  it("discards draft/reload when the live node diverges after await", () => {
    expect(
      strategyMutationCompletion({
        requestSolutionId: "s1",
        requestNodeId: "p0",
        liveSolutionId: "s1",
        liveNodeId: "p0",
      }),
    ).toEqual({ applyEditsList: true, applyDraft: true, reloadNode: true });
    expect(
      strategyMutationCompletion({
        requestSolutionId: "s1",
        requestNodeId: "p0",
        liveSolutionId: "s1",
        liveNodeId: "p1",
      }),
    ).toEqual({ applyEditsList: true, applyDraft: false, reloadNode: false });
    expect(
      strategyMutationCompletion({
        requestSolutionId: "s1",
        requestNodeId: "p0",
        liveSolutionId: "s2",
        liveNodeId: "p0",
      }),
    ).toEqual({ applyEditsList: false, applyDraft: false, reloadNode: false });
  });
});
