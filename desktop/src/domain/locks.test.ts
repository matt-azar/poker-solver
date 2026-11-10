import { describe, expect, it } from "vitest";
import {
  isHandLocked,
  lineLockNodeId,
  lockForNode,
  lockMutationCompletion,
  normalizeProbs,
  seedProbsFromStrategy,
  setLinkedActionProb,
  toggleHandIndex,
  uniformProbs,
  weightedStrategyMix,
} from "./locks";

describe("lock helpers", () => {
  it("rejects all-zero rows but keeps single-action zeros after normalize", () => {
    const empty = normalizeProbs([0, 0, 0]);
    expect(empty.valid).toBe(false);
    expect(empty.sum).toBe(0);
    const withZero = normalizeProbs([0, 1, 0]);
    expect(withZero.valid).toBe(true);
    expect(withZero.probs).toEqual([0, 1, 0]);
  });

  it("normalizes positive rows", () => {
    const result = normalizeProbs([1, 1, 2]);
    expect(result.valid).toBe(true);
    expect(result.probs[0]).toBeCloseTo(0.25, 12);
    expect(result.probs[2]).toBeCloseTo(0.5, 12);
  });

  it("toggles hand selection and seeds strategy averages", () => {
    expect(toggleHandIndex([1, 3], 2)).toEqual([1, 2, 3]);
    expect(toggleHandIndex([1, 2], 2)).toEqual([1]);
    const seeded = seedProbsFromStrategy(
      [
        [0.2, 0.8],
        [0.5, 0.5],
      ],
      [0, 1],
      2,
    );
    expect(seeded[0]).toBeCloseTo(0.35, 12);
    expect(seeded[1]).toBeCloseTo(0.65, 12);
    expect(uniformProbs(4).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });

  it("marks full-node locks as locking every hand", () => {
    expect(
      isHandLocked({ node_id: "p0", kind: "full", hand_indices: [], probs: [1] }, 4),
    ).toBe(true);
    expect(
      isHandLocked(
        { node_id: "p0", kind: "selected", hand_indices: [1, 3], probs: [1] },
        2,
      ),
    ).toBe(false);
  });

  it("prefers an exact runout lock over a line lock for the same index", () => {
    expect(lineLockNodeId("p12.t-1.r7")).toBe("p12.t-1.r-1");
    const locks = [
      {
        node_id: "p12.t-1.r-1",
        scope: "line" as const,
        kind: "full" as const,
        hand_indices: [],
        probs: [0, 1],
      },
      {
        node_id: "p12.t-1.r7",
        scope: "node" as const,
        kind: "full" as const,
        hand_indices: [],
        probs: [1, 0],
      },
    ];
    expect(lockForNode(locks, "p12.t-1.r7")?.node_id).toBe("p12.t-1.r7");
    expect(lockForNode(locks, "p12.t-1.r9")?.node_id).toBe("p12.t-1.r-1");
  });

  it("weights strategy mixes by marginal and links slider edits", () => {
    const mix = weightedStrategyMix(
      [
        [1, 0],
        [0, 1],
      ],
      [0, 1],
      2,
      [3, 1],
    );
    expect(mix?.[0]).toBeCloseTo(0.75, 12);
    expect(mix?.[1]).toBeCloseTo(0.25, 12);
    const linked = setLinkedActionProb([0.4, 0.6], 0, 0.7);
    expect(linked[0]).toBeCloseTo(0.7, 12);
    expect(linked[1]).toBeCloseTo(0.3, 12);
    expect(linked[0] + linked[1]).toBeCloseTo(1, 12);
  });

  it("discards draft writes when the live node diverges after await", () => {
    expect(
      lockMutationCompletion({
        requestSolutionId: "s1",
        requestNodeId: "p0",
        liveSolutionId: "s1",
        liveNodeId: "p0",
      }),
    ).toEqual({ applyLocksList: true, applyDraft: true });
    expect(
      lockMutationCompletion({
        requestSolutionId: "s1",
        requestNodeId: "p0",
        liveSolutionId: "s1",
        liveNodeId: "p1",
      }),
    ).toEqual({ applyLocksList: true, applyDraft: false });
    expect(
      lockMutationCompletion({
        requestSolutionId: "s1",
        requestNodeId: "p0",
        liveSolutionId: "s2",
        liveNodeId: "p0",
      }),
    ).toEqual({ applyLocksList: false, applyDraft: false });
  });
});
