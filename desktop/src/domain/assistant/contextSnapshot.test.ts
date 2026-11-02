import { describe, expect, it } from "vitest";
import { DEFAULT_SPOT, type NodePayload, type SpotDraft } from "../types";
import {
  ASSISTANT_CONTEXT_SNAPSHOT_VERSION,
  SELECTED_HAND_ANALYSIS_TOOL_SCHEMA,
  buildAssistantContextSnapshot,
  formatContextIndicator,
  summarizeContextSnapshot,
} from "./contextSnapshot";

function draft(partial: Partial<SpotDraft> = {}): SpotDraft {
  return { ...DEFAULT_SPOT, ...partial };
}

describe("buildAssistantContextSnapshot", () => {
  it("versions the snapshot and separates Build draft identity", () => {
    const snapshot = buildAssistantContextSnapshot({
      draft: draft({ boardText: "As7d2c", pot: 100, stack: 200, rakeRate: 0.05, rakeCap: 3 }),
      draftRevision: 4,
      rangeSourceLabel: "100NL",
    });

    expect(snapshot.version).toBe(ASSISTANT_CONTEXT_SNAPSHOT_VERSION);
    expect(snapshot.units).toBe("bb");
    expect(snapshot.build.kind).toBe("build_draft");
    expect(snapshot.build.draftRevision).toBe(4);
    expect(snapshot.build.board).toBe("As7d2c");
    expect(snapshot.build.pot).toBe(100);
    expect(snapshot.build.stack).toBe(200);
    expect(snapshot.build.solveRake).toEqual({ rate: 0.05, cap: 3 });
    expect(snapshot.build.rangeSourceLabel).toBe("100NL");
    expect(snapshot.publishedSolution.present).toBe(false);
    expect(snapshot.studyNode.present).toBe(false);
    expect(snapshot.selectedHand.present).toBe(false);
    expect(snapshot.absences.some((line) => /No published solution/i.test(line))).toBe(true);
    expect(snapshot.absences.some((line) => /No Study node/i.test(line))).toBe(true);
    expect(formatContextIndicator(snapshot)).toBe("Context: Build draft");
  });

  it("includes published-solution and study-node identities when present", () => {
    const node: NodePayload = {
      node_id: "n1",
      kind: "decision",
      line: "root/Check",
      to_act: "IP",
      actions: ["Check", "Bet 50"],
      to_call: 0,
      pot: 55,
      stacks: [97.5, 97.5],
      combos: ["AsAh", "AsAd"],
      reach: [1, 1],
      marginal: [1, 1],
      reach_defined: true,
      strategy: [
        [0.8, 0.2],
        [0.5, 0.5],
      ],
    };

    const snapshot = buildAssistantContextSnapshot({
      draft: draft({ pot: 55, stack: 97.5 }),
      draftRevision: 2,
      solutionId: "sol-9",
      status: {
        solution_id: "sol-9",
        status_generation: 3,
        pot: 55,
        stack: 97.5,
        nash_gap: 0.012,
        iterations: 400,
        board: ["As", "7d", "2c"],
      },
      phase: "complete",
      currentNode: node,
      selectedCell: { text: "AA" },
      nodeValues: {
        pending: false,
        node_id: "n1",
        combos: ["AsAh", "AsAd"],
        value: [1.2, 0.8],
        action_ev: [
          [1.0, 1.5],
          [0.7, 0.9],
        ],
        ev_defined: [true, true],
        utility_basis: "root_centered",
        local_offset: 0,
      },
      evDisplayBasis: "local",
    });

    expect(snapshot.publishedSolution.present).toBe(true);
    expect(snapshot.publishedSolution.solutionId).toBe("sol-9");
    expect(snapshot.publishedSolution.nashGap).toBe(0.012);
    expect(snapshot.studyNode.present).toBe(true);
    expect(snapshot.studyNode.nodeId).toBe("n1");
    expect(snapshot.studyNode.actions).toEqual(["Check", "Bet 50"]);
    expect(snapshot.selectedHand.present).toBe(true);
    expect(snapshot.selectedHand.label).toBe("AA");
    expect(snapshot.selectedHand.strategy).not.toBeNull();
    expect(snapshot.selectedHand.mixedEv).not.toBeNull();
    expect(snapshot.readiness.hasPublishedSolution).toBe(true);
    expect(snapshot.readiness.hasDecisionNode).toBe(true);
    expect(snapshot.readiness.strategyLoaded).toBe(true);
    expect(snapshot.readiness.convergenceAvailable).toBe(true);
    expect(formatContextIndicator(snapshot)).toBe(
      "Context: Build draft / Study node / selected hand",
    );
    expect(summarizeContextSnapshot(snapshot)).toContain("hand=AA");
    expect(summarizeContextSnapshot(snapshot)).toContain("solution=sol-9");
  });

  it("states missing EV evidence honestly when values are pending", () => {
    const node: NodePayload = {
      node_id: "n2",
      kind: "decision",
      actions: ["Check"],
      combos: ["AsAh"],
      reach: [1],
      marginal: [1],
      reach_defined: true,
      strategy: [[1]],
    };
    const snapshot = buildAssistantContextSnapshot({
      draft: draft(),
      draftRevision: 0,
      solutionId: "sol-1",
      status: { solution_id: "sol-1", nash_gap: 0.1 },
      currentNode: node,
      selectedCell: { text: "AA" },
      nodeValues: { pending: true, node_id: "n2" },
    });

    expect(snapshot.selectedHand.strategy).not.toBeNull();
    expect(snapshot.selectedHand.mixedEv).toBeNull();
    expect(
      snapshot.selectedHand.absence.some((line) => /action EV evidence is missing/i.test(line)),
    ).toBe(true);
  });

  it("exposes a snapshot-only selected-hand tool schema without solve/filesystem tools", () => {
    expect(SELECTED_HAND_ANALYSIS_TOOL_SCHEMA.name).toBe("query_selected_hand_analysis");
    expect(SELECTED_HAND_ANALYSIS_TOOL_SCHEMA.status).toBe("snapshot_only");
    expect(SELECTED_HAND_ANALYSIS_TOOL_SCHEMA.deferredTools).toContain("compare_runouts");
  });
});
