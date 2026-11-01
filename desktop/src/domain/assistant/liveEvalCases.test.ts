import { describe, expect, it } from "vitest";
import {
  LIVE_EVAL_CASES,
  LIVE_EVAL_PROFILE_IDS,
  scoreLiveEvalCase,
  summarizeLiveEval,
  type LiveEvalCase,
} from "./liveEvalCases";
import type { InterpretProposal } from "./provider";

function prepare(partial: {
  potType?: "SRP" | "3BP" | "4BP";
  stakesLabel?: string;
  stackBb?: number;
  oop?: string;
  ip?: string;
  selectedProfileId?: string;
}): InterpretProposal {
  return {
    kind: "prepare_study",
    intent: {
      mode: "create",
      potType: partial.potType,
      stakesLabel: partial.stakesLabel,
      stackBb: partial.stackBb,
      oopPosition: partial.oop,
      ipPosition: partial.ip,
      profileQuery: partial.selectedProfileId,
    },
    selectedProfileId: partial.selectedProfileId,
    stakesLabel: partial.stakesLabel,
    stackBb: partial.stackBb,
  };
}

describe("liveEvalCases scoring (offline)", () => {
  it("exports a representative set covering product rules", () => {
    const ids = new Set(LIVE_EVAL_CASES.map((c) => c.id));
    expect(ids.has("srp-100nl-explicit")).toBe(true);
    expect(ids.has("srp-silence-defaults")).toBe(true);
    expect(ids.has("missing-pot-type-clarify")).toBe(true);
    expect(ids.has("my-100nl-profile-not-personal")).toBe(true);
    expect(ids.has("100nl-vs-100bb-both-named")).toBe(true);
    expect(ids.has("3bp-btn-bb-100nl")).toBe(true);
    expect(ids.has("cev-chip-ev-wording")).toBe(true);
    expect(LIVE_EVAL_CASES.length).toBeGreaterThanOrEqual(8);
  });

  it("scores a correct 100NL SRP proposal as a full pass", () => {
    const evalCase = LIVE_EVAL_CASES.find((c) => c.id === "srp-100nl-explicit")!;
    const score = scoreLiveEvalCase(
      evalCase,
      prepare({
        potType: "SRP",
        stakesLabel: "100NL",
        oop: "BB",
        ip: "CO",
        selectedProfileId: LIVE_EVAL_PROFILE_IDS.nl25,
      }),
    );
    expect(score.ok).toBe(true);
  });

  it("accepts silence or explicit cEV / 100 for default path", () => {
    const evalCase = LIVE_EVAL_CASES.find((c) => c.id === "srp-silence-defaults")!;
    const silent = scoreLiveEvalCase(
      evalCase,
      prepare({
        potType: "SRP",
        oop: "BB",
        ip: "CO",
        selectedProfileId: LIVE_EVAL_PROFILE_IDS.cev25,
      }),
    );
    expect(silent.ok).toBe(true);

    const filled = scoreLiveEvalCase(
      evalCase,
      prepare({
        potType: "SRP",
        stakesLabel: "cEV",
        stackBb: 100,
        oop: "BB",
        ip: "CO",
        selectedProfileId: LIVE_EVAL_PROFILE_IDS.cev25,
      }),
    );
    expect(filled.ok).toBe(true);
  });

  it("fails when pot type is guessed on a clarify case", () => {
    const evalCase = LIVE_EVAL_CASES.find((c) => c.id === "missing-pot-type-clarify")!;
    const bad = scoreLiveEvalCase(
      evalCase,
      prepare({
        potType: "SRP",
        stakesLabel: "100NL",
        oop: "BB",
        ip: "CO",
        selectedProfileId: LIVE_EVAL_PROFILE_IDS.nl25,
      }),
    );
    expect(bad.ok).toBe(false);
    expect(bad.fields.find((f) => f.field === "kind")?.ok).toBe(false);
  });

  it("summarizes field accuracy across cases", () => {
    const cases: LiveEvalCase[] = [
      LIVE_EVAL_CASES.find((c) => c.id === "srp-100nl-explicit")!,
      LIVE_EVAL_CASES.find((c) => c.id === "missing-pot-type-clarify")!,
    ];
    const scores = [
      scoreLiveEvalCase(
        cases[0]!,
        prepare({
          potType: "SRP",
          stakesLabel: "100NL",
          oop: "BB",
          ip: "CO",
          selectedProfileId: LIVE_EVAL_PROFILE_IDS.nl25,
        }),
      ),
      scoreLiveEvalCase(cases[1]!, {
        kind: "clarify",
        questions: ["Which pot type — SRP, 3BP, or 4BP?"],
      }),
    ];
    const summary = summarizeLiveEval(scores);
    expect(summary.passed).toBe(2);
    expect(summary.fieldAccuracy).toBe(1);
  });
});
