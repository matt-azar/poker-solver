import { describe, expect, it } from "vitest";
import {
  classifyStrategyEditFailure,
  editForNode,
  isHandEdited,
  isStrategyEditSessionDead,
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

  it("classifies pipe/InvalidFrame deaths vs recoverable Apply rejects (ZR-119)", () => {
    expect(isStrategyEditSessionDead("solver-engine pipe closed")).toBe(true);
    expect(isStrategyEditSessionDead("invalid_frame: InvalidFrame")).toBe(true);
    expect(isStrategyEditSessionDead("invalid_request: invalid strategy probability row")).toBe(
      false,
    );

    const dead = classifyStrategyEditFailure(new Error("solver-engine pipe closed"));
    expect(dead.sessionDead).toBe(true);
    expect(dead.message).toMatch(/Reconnect/);
    expect(dead.message).toMatch(/pipe closed/);

    const soft = classifyStrategyEditFailure(
      new Error("invalid_request: probs length must match action arity"),
    );
    expect(soft.sessionDead).toBe(false);
    expect(soft.message).toContain("probs length must match action arity");
    expect(soft.message).not.toMatch(/Engine unreachable/);
  });
});
