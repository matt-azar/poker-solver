import { describe, expect, it } from "vitest";
import {
  isHandLocked,
  normalizeProbs,
  seedProbsFromStrategy,
  toggleHandIndex,
  uniformProbs,
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
});
