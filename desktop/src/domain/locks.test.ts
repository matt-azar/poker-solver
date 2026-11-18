import { describe, expect, it } from "vitest";
import {
  applyFrequencySliderEdit,
  buildFullRangeLockDraft,
  comboProbsRowsForHands,
  compareActionAggregates,
  compareChangeDescription,
  isHandLocked,
  lineLockNodeId,
  lockAffectedComboCount,
  lockDraftIsDirty,
  lockForNode,
  lockMutationCompletion,
  normalizeProbs,
  reallocateComboStrategiesByEv,
  rematerializeComboProbsByHand,
  seedComboProbsFromStrategy,
  seedProbsFromStrategy,
  setLinkedActionProb,
  toggleHandIndex,
  uniformProbs,
  weightedStrategyMix,
  type ComparePayload,
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

  it("seeds per-combo lock rows without averaging opposite pure actions", () => {
    const rows = seedComboProbsFromStrategy(
      [
        [1, 0],
        [0, 1],
      ],
      [0, 1],
      2,
    );
    expect(rows).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  it("keys draft rows by combo identity across selection changes", () => {
    const strategy = [
      [1, 0],
      [0, 1],
      [0.5, 0.5],
    ];
    const afterEdit = rematerializeComboProbsByHand({
      previous: { 0: [0.8, 0.2] },
      nextHandIndices: [0, 1],
      strategy,
      actionCount: 2,
    });
    expect(afterEdit?.[0]).toEqual([0.8, 0.2]);
    expect(afterEdit?.[1]).toEqual([0, 1]);

    // Deselect 0, select 2 — combo 0's edit must not attach to combo 2.
    const afterToggle = rematerializeComboProbsByHand({
      previous: afterEdit,
      nextHandIndices: [1, 2],
      strategy,
      actionCount: 2,
    });
    expect(afterToggle?.[0]).toBeUndefined();
    expect(afterToggle?.[1]).toEqual([0, 1]);
    expect(afterToggle?.[2]).toEqual([0.5, 0.5]);
    expect(comboProbsRowsForHands(afterToggle, [1, 2])).toEqual([
      [0, 1],
      [0.5, 0.5],
    ]);
  });

  it("builds an explicit full-range freeze from each combo's mix", () => {
    const draft = buildFullRangeLockDraft({
      strategy: [
        [1, 0],
        [0, 1],
      ],
      actionCount: 2,
      handCount: 2,
      existingByHand: { 0: [0.75, 0.25] },
    });
    expect(draft?.kind).toBe("selected");
    expect(draft?.handIndices).toEqual([0, 1]);
    expect(draft?.comboProbsByHand?.[0]).toEqual([0.75, 0.25]);
    expect(draft?.comboProbsByHand?.[1]).toEqual([0, 1]);
  });

  it("skips all-zero / blocked combos when building a full-range freeze", () => {
    const draft = buildFullRangeLockDraft({
      strategy: [
        [1, 0],
        [0, 0], // blocked — no strategy slot on this board
        [0.25, 0.75],
      ],
      actionCount: 2,
      handCount: 3,
    });
    expect(draft?.handIndices).toEqual([0, 2]);
    expect(draft?.comboProbsByHand?.[0]).toEqual([1, 0]);
    expect(draft?.comboProbsByHand?.[1]).toBeUndefined();
    expect(draft?.comboProbsByHand?.[2]).toEqual([0.25, 0.75]);
    expect(
      buildFullRangeLockDraft({
        strategy: [
          [0, 0],
          [0, 0],
        ],
        actionCount: 2,
        handCount: 2,
      }),
    ).toBeNull();
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

  it("distinguishes flop-root node scope from line at the same node_id", () => {
    const locks = [
      {
        node_id: "p0.t-1.r-1",
        scope: "line" as const,
        kind: "full" as const,
        hand_indices: [],
        probs: [0, 1],
      },
      {
        node_id: "p0.t-1.r-1",
        scope: "node" as const,
        kind: "full" as const,
        hand_indices: [],
        probs: [1, 0],
      },
    ];
    expect(lockForNode(locks, "p0.t-1.r-1")?.scope).toBe("node");
    expect(lockForNode(locks, "p0.t-1.r-1")?.probs).toEqual([1, 0]);
  });

  it("treats unlock-all full sentinel as unlocked", () => {
    expect(
      isHandLocked(
        { node_id: "p0.t-1.r7", scope: "node", kind: "full", hand_indices: [], probs: [] },
        0,
      ),
    ).toBe(false);
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
    const protectedLinked = setLinkedActionProb([0.5, 0.3, 0.2], 0, 0.7, [
      false,
      true,
      false,
    ]);
    expect(protectedLinked[0]).toBeCloseTo(0.7, 12);
    expect(protectedLinked[1]).toBeCloseTo(0.3, 12);
    expect(protectedLinked[2]).toBeCloseTo(0.0, 12);
  });

  it("reallocates across combos by EV preference and mixes near-ties (Pio example)", () => {
    // Raise / Call / Fold — pot-fraction EV from Pio Viewer manual.
    const comboProbs = [
      [1, 0, 0], // AA
      [0.6, 0.4, 0], // KK
      [0, 1, 0], // JJ (already 100% call — no capacity)
      [0, 0, 1], // 77
      [0, 0, 1], // 22
    ];
    const actionEv = [
      [99.9, 100, 0],
      [80, 79.5, 0],
      [55, 66, 0],
      [-80, -0.1, 0],
      [-120, -60, 0],
    ];
    // Initial call mass: 0+0.4+1+0+0 = 1.4 / 5 = 0.28. Add 0.5 combo → 1.9/5 = 0.38.
    // Threshold 1 matches Pio's "1% of pot" when EV is expressed in % of pot.
    const toward = reallocateComboStrategiesByEv({
      comboProbs,
      actionEv,
      targetAction: 1,
      targetFreq: 1.9 / 5,
      nearTieThreshold: 1,
    });
    expect(toward.aggregate[1]).toBeCloseTo(1.9 / 5, 5);
    // AA has the best call preference; JJ has no capacity; 22 is far outside the band.
    expect(toward.comboProbs[0][1]).toBeGreaterThan(0);
    expect(toward.comboProbs[2][1]).toBeCloseTo(1, 8);
    expect(toward.comboProbs[4][1]).toBeLessThan(0.05);
    // Near-tie hands AA/KK/77 should share some of the added call (not dump all on AA).
    const addedOnAa = toward.comboProbs[0][1] - comboProbs[0][1];
    const addedOnKk = toward.comboProbs[1][1] - comboProbs[1][1];
    const addedOn77 = toward.comboProbs[3][1] - comboProbs[3][1];
    expect(addedOnAa + addedOnKk + addedOn77).toBeCloseTo(0.5, 4);
    expect(addedOnAa).toBeLessThan(0.5);
    expect(addedOnAa).toBeGreaterThan(0);
  });

  it("respects protected actions when reallocating by EV", () => {
    const comboProbs = [
      [0.5, 0.5, 0],
      [0.5, 0.5, 0],
    ];
    const actionEv = [
      [1, 0.9, 0],
      [1, 0.9, 0],
    ];
    const result = reallocateComboStrategiesByEv({
      comboProbs,
      actionEv,
      targetAction: 1,
      targetFreq: 0.75,
      protectedActions: [true, false, false],
      nearTieThreshold: 0.01,
    });
    // Raise is protected — must stay 0.5 on each row; call can only grow from Fold (0).
    expect(result.comboProbs[0][0]).toBeCloseTo(0.5, 8);
    expect(result.comboProbs[1][0]).toBeCloseTo(0.5, 8);
    // No unprotected donor mass → aggregate Call unchanged.
    expect(result.aggregate[1]).toBeCloseTo(0.5, 8);
  });

  it("moves mass across combos toward an aggregate target without flattening rows", () => {
    const edited = applyFrequencySliderEdit({
      comboProbs: [
        [1, 0],
        [0, 1],
      ],
      actionEv: [
        [1, 0],
        [0, 1],
      ],
      targetAction: 0,
      targetFreq: 0.5,
      nearTieThreshold: 0.01,
    });
    expect(edited.aggregate[0]).toBeCloseTo(0.5, 5);
    // Prefer increasing Check on the hand that already likes Check (row 0),
    // and/or reducing Check only on the hand that hates it — rows stay distinct.
    expect(edited.comboProbs[0][0]).not.toBeCloseTo(edited.comboProbs[1][0], 2);
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

  it("detects dirty lock drafts and affected combo counts", () => {
    const baseline = {
      kind: "selected" as const,
      handIndices: [0, 1],
      probs: [0.8, 0.2],
      comboProbsByHand: { 0: [0.8, 0.2], 1: [0.7, 0.3] },
    };
    expect(lockDraftIsDirty(baseline, baseline)).toBe(false);
    expect(
      lockDraftIsDirty(
        { ...baseline, probs: [0.5, 0.5] },
        baseline,
      ),
    ).toBe(true);
    expect(lockAffectedComboCount(baseline, 10)).toBe(2);
    expect(
      lockAffectedComboCount(
        { kind: "full", handIndices: [], probs: [1, 0] },
        216,
      ),
    ).toBe(216);
  });

  it("aggregates compare actions with each strategy's weights", () => {
    const note: ComparePayload = {
      baseline_id: "s1",
      scenario_id: "s2",
      node_id: "p0",
      baseline_value: 1,
      scenario_value: 2,
      value_delta: 1,
      baseline_nash_gap: 0,
      scenario_nash_gap: 0,
      actions: ["Check", "Bet"],
      hands: [
        {
          combo: "AcAd",
          locked: true,
          baseline: [1, 0],
          scenario: [0, 1],
          delta: [-1, 1],
          baseline_weight: 1,
          scenario_weight: 3,
        },
        {
          combo: "KcKd",
          locked: false,
          baseline: [0, 1],
          scenario: [1, 0],
          delta: [1, -1],
          baseline_weight: 1,
          scenario_weight: 1,
        },
      ],
    };
    const summary = compareActionAggregates(note);
    expect(summary).toHaveLength(2);
    // baseline equal weight → Check 0.5; scenario 3:1 → Check 0.25
    expect(summary[0]!.baseline).toBeCloseTo(0.5, 6);
    expect(summary[0]!.scenario).toBeCloseTo(0.25, 6);
    expect(compareChangeDescription(summary)).toMatch(/Check|Bet/);
  });

  it("prefers host action_summary when present", () => {
    const note: ComparePayload = {
      baseline_id: "s1",
      scenario_id: "s2",
      node_id: "p0",
      baseline_value: 0,
      scenario_value: 0,
      value_delta: 0,
      baseline_nash_gap: 0,
      scenario_nash_gap: 0,
      actions: ["Check"],
      hands: [],
      action_summary: [
        { action: "Check", baseline: 0.6, scenario: 0.4, delta: -0.2 },
      ],
    };
    expect(compareActionAggregates(note)[0]!.baseline).toBeCloseTo(0.6, 6);
  });
});
