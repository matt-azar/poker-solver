/**
 * Representative live OpenAI interpretation cases for the study setup assistant.
 *
 * These are exercised by `npm run test:assistant-live` when a credential is
 * present. They are intentionally excluded from ordinary `npm test` / CI.
 */

import type { InterpretProposal } from "./provider";

export type PotTypeExpect = "SRP" | "3BP" | "4BP";

/** Field expectations after the model emits a structured proposal. */
export interface LiveEvalExpect {
  /** One allowed kind, or any of several. */
  kind: InterpretProposal["kind"] | InterpretProposal["kind"][];
  potType?: PotTypeExpect | null;
  /**
   * Exact stakes label, `null` (must be absent), or `silent-or-cev`
   * (absent or normalized cEV — silence defaults may be filled by the model or resolve).
   */
  stakesLabel?: string | null | "silent-or-cev";
  /**
   * Exact stack, `null` (must be absent), or `silent-or-100`
   * (absent or 100 — never invent from an NL label alone beyond the silence default).
   */
  stackBb?: number | null | "silent-or-100";
  oopPosition?: string;
  ipPosition?: string;
  /** Exact id, any of several, or `null` (must not select a profile). */
  selectedProfileId?: string | readonly string[] | null;
  /** When kind is clarify, at least one question should match. */
  questionMatch?: RegExp;
}

export interface LiveEvalCase {
  id: string;
  text: string;
  /** Why this case exists (human-facing). */
  rationale: string;
  expect: LiveEvalExpect;
}

/**
 * Catalogue ids used by the live harness (bundled synthetic fixtures).
 * Live eval loads the same fixtures the desktop app ships — not a production pack.
 */
export const LIVE_EVAL_PROFILE_IDS = {
  cev25: "fixture-co-bb-srp-100bb-2.5x",
  nl25: "fixture-co-bb-srp-100bb-2.5x-100nl",
  cev3x: "fixture-co-bb-srp-100bb-3x",
  btnBb3bp: "fixture-btn-bb-3bp-100bb-100nl",
} as const;

export const LIVE_EVAL_CASES: readonly LiveEvalCase[] = [
  {
    id: "srp-100nl-explicit",
    text: "Set up CO vs BB SRP with 100NL ranges",
    rationale: "Named pot type + rake structure; 100NL must not invent stack by itself.",
    expect: {
      kind: "prepare_study",
      potType: "SRP",
      stakesLabel: "100NL",
      stackBb: "silent-or-100",
      oopPosition: "BB",
      ipPosition: "CO",
      selectedProfileId: LIVE_EVAL_PROFILE_IDS.nl25,
    },
  },
  {
    id: "srp-silence-defaults",
    text: "Set up CO vs BB SRP",
    rationale: "Missing rake → cEV; missing stack → 100bb (resolve and/or model).",
    expect: {
      kind: "prepare_study",
      potType: "SRP",
      stakesLabel: "silent-or-cev",
      stackBb: "silent-or-100",
      oopPosition: "BB",
      ipPosition: "CO",
      selectedProfileId: LIVE_EVAL_PROFILE_IDS.cev25,
    },
  },
  {
    id: "missing-pot-type-clarify",
    text: "Set up CO vs BB with 100NL ranges",
    rationale: "Pot type required — clarify; do not guess SRP.",
    expect: {
      kind: "clarify",
      questionMatch: /pot type|SRP|3BP|4BP/i,
    },
  },
  {
    id: "my-100nl-profile-not-personal",
    text: "Set up CO vs BB using my 100NL profile",
    rationale:
      "“my 100NL profile” is not a personal profile picker — still need pot type.",
    expect: {
      kind: "clarify",
      questionMatch: /pot type|SRP|3BP|4BP/i,
    },
  },
  {
    id: "100nl-vs-100bb-both-named",
    text: "Prepare a CO vs BB SRP study at 100bb for 100NL",
    rationale: "Distinguish rake structure (100NL) from stack depth (100bb).",
    expect: {
      kind: "prepare_study",
      potType: "SRP",
      stakesLabel: "100NL",
      stackBb: 100,
      oopPosition: "BB",
      ipPosition: "CO",
      selectedProfileId: LIVE_EVAL_PROFILE_IDS.nl25,
    },
  },
  {
    id: "varied-wording-single-raised",
    text: "Build a single-raised pot study: CO opens, BB calls, standard GTO ranges for 100NL",
    rationale: "Varied wording for SRP + 100NL without saying “SRP” literally.",
    expect: {
      kind: ["prepare_study", "clarify"],
      // Prefer prepare with SRP; clarify is acceptable if the model asks to confirm pot type.
      potType: "SRP",
      stakesLabel: "100NL",
      oopPosition: "BB",
      ipPosition: "CO",
      selectedProfileId: [
        LIVE_EVAL_PROFILE_IDS.nl25,
        // clarify path may omit selection
      ],
    },
  },
  {
    id: "3bp-btn-bb-100nl",
    text: "Set up BTN vs BB 3BP with 100NL ranges",
    rationale: "3-bet pot path against the synthetic BTN/BB 3BP fixture.",
    expect: {
      kind: "prepare_study",
      potType: "3BP",
      stakesLabel: "100NL",
      stackBb: "silent-or-100",
      oopPosition: "BB",
      ipPosition: "BTN",
      selectedProfileId: LIVE_EVAL_PROFILE_IDS.btnBb3bp,
    },
  },
  {
    id: "update-board",
    text: "Change the flop to As 7d 2c",
    rationale: "Board edit should not invent ranges or profiles.",
    expect: {
      kind: "update_study",
      selectedProfileId: null,
    },
  },
  {
    id: "duplicate-150bb",
    text: "Duplicate this setup at 150bb",
    rationale: "Duplicate mode with explicit stack override.",
    expect: {
      kind: "duplicate_study",
      stackBb: 150,
    },
  },
  {
    id: "cev-chip-ev-wording",
    text: "Set up CO vs BB SRP for chip EV / no rake",
    rationale: "cEV aliases via natural wording.",
    expect: {
      kind: "prepare_study",
      potType: "SRP",
      stakesLabel: "silent-or-cev",
      stackBb: "silent-or-100",
      selectedProfileId: LIVE_EVAL_PROFILE_IDS.cev25,
    },
  },
];

export interface FieldScore {
  field: string;
  ok: boolean;
  expected: string;
  actual: string;
}

export interface CaseScore {
  id: string;
  ok: boolean;
  fields: FieldScore[];
}

function kindsOf(expect: LiveEvalExpect): InterpretProposal["kind"][] {
  return Array.isArray(expect.kind) ? expect.kind : [expect.kind];
}

function proposalStakes(proposal: InterpretProposal): string | undefined {
  if (
    proposal.kind === "prepare_study" ||
    proposal.kind === "update_study" ||
    proposal.kind === "duplicate_study"
  ) {
    return proposal.stakesLabel ?? proposal.intent.stakesLabel;
  }
  return undefined;
}

function proposalStack(proposal: InterpretProposal): number | undefined {
  if (
    proposal.kind === "prepare_study" ||
    proposal.kind === "update_study" ||
    proposal.kind === "duplicate_study"
  ) {
    return proposal.stackBb ?? proposal.intent.stackBb;
  }
  return undefined;
}

function proposalPotType(proposal: InterpretProposal): string | undefined {
  if (
    proposal.kind === "prepare_study" ||
    proposal.kind === "update_study" ||
    proposal.kind === "duplicate_study"
  ) {
    return proposal.intent.potType;
  }
  return undefined;
}

function proposalPositions(proposal: InterpretProposal): {
  oop?: string;
  ip?: string;
} {
  if (
    proposal.kind === "prepare_study" ||
    proposal.kind === "update_study" ||
    proposal.kind === "duplicate_study"
  ) {
    return {
      oop: proposal.intent.oopPosition,
      ip: proposal.intent.ipPosition,
    };
  }
  return {};
}

function proposalSelectedId(proposal: InterpretProposal): string | undefined {
  if (
    proposal.kind === "prepare_study" ||
    proposal.kind === "update_study" ||
    proposal.kind === "duplicate_study"
  ) {
    return proposal.selectedProfileId ?? proposal.intent.profileQuery;
  }
  return undefined;
}

function normalizeRake(label: string | undefined): string {
  const raw = (label ?? "").trim().toUpperCase().replace(/\s+/g, "");
  if (
    !raw ||
    raw === "CEV" ||
    raw === "CHIPEV" ||
    raw === "CHIP_EV" ||
    raw === "CHIP-EV" ||
    raw === "NONE" ||
    raw === "NORAKE" ||
    raw === "NORAKE."
  ) {
    return "CEV";
  }
  return raw;
}

/**
 * Score one proposal against a case. Pure — safe for unit tests without network.
 */
export function scoreLiveEvalCase(
  evalCase: LiveEvalCase,
  proposal: InterpretProposal,
): CaseScore {
  const fields: FieldScore[] = [];
  const allowed = kindsOf(evalCase.expect);

  fields.push({
    field: "kind",
    ok: allowed.includes(proposal.kind),
    expected: allowed.join("|"),
    actual: proposal.kind,
  });

  if (evalCase.expect.potType !== undefined) {
    const actual = proposalPotType(proposal);
    if (evalCase.expect.potType === null) {
      fields.push({
        field: "potType",
        ok: actual === undefined,
        expected: "(absent)",
        actual: actual ?? "(absent)",
      });
    } else if (allowed.includes(proposal.kind) && proposal.kind === "clarify") {
      // Varied-wording cases may clarify instead of committing pot type.
      fields.push({
        field: "potType",
        ok: true,
        expected: `${evalCase.expect.potType} (or clarify)`,
        actual: "(clarify)",
      });
    } else {
      fields.push({
        field: "potType",
        ok: actual === evalCase.expect.potType,
        expected: evalCase.expect.potType,
        actual: actual ?? "(absent)",
      });
    }
  }

  if (evalCase.expect.stakesLabel !== undefined) {
    const actual = proposalStakes(proposal);
    if (evalCase.expect.stakesLabel === null) {
      fields.push({
        field: "stakesLabel",
        ok: actual === undefined,
        expected: "(absent)",
        actual: actual ?? "(absent)",
      });
    } else if (evalCase.expect.stakesLabel === "silent-or-cev") {
      const ok =
        actual === undefined || normalizeRake(actual) === "CEV";
      fields.push({
        field: "stakesLabel",
        ok,
        expected: "absent|cEV",
        actual: actual ?? "(absent)",
      });
    } else {
      fields.push({
        field: "stakesLabel",
        ok: normalizeRake(actual) === normalizeRake(evalCase.expect.stakesLabel),
        expected: evalCase.expect.stakesLabel,
        actual: actual ?? "(absent)",
      });
    }
  }

  if (evalCase.expect.stackBb !== undefined) {
    const actual = proposalStack(proposal);
    if (evalCase.expect.stackBb === null) {
      fields.push({
        field: "stackBb",
        ok: actual === undefined,
        expected: "(absent)",
        actual: actual === undefined ? "(absent)" : String(actual),
      });
    } else if (evalCase.expect.stackBb === "silent-or-100") {
      const ok = actual === undefined || actual === 100;
      fields.push({
        field: "stackBb",
        ok,
        expected: "absent|100",
        actual: actual === undefined ? "(absent)" : String(actual),
      });
    } else {
      fields.push({
        field: "stackBb",
        ok: actual === evalCase.expect.stackBb,
        expected: String(evalCase.expect.stackBb),
        actual: actual === undefined ? "(absent)" : String(actual),
      });
    }
  }

  const positions = proposalPositions(proposal);
  if (evalCase.expect.oopPosition !== undefined) {
    fields.push({
      field: "oopPosition",
      ok:
        (positions.oop ?? "").toUpperCase() ===
        evalCase.expect.oopPosition.toUpperCase(),
      expected: evalCase.expect.oopPosition,
      actual: positions.oop ?? "(absent)",
    });
  }
  if (evalCase.expect.ipPosition !== undefined) {
    fields.push({
      field: "ipPosition",
      ok:
        (positions.ip ?? "").toUpperCase() ===
        evalCase.expect.ipPosition.toUpperCase(),
      expected: evalCase.expect.ipPosition,
      actual: positions.ip ?? "(absent)",
    });
  }

  if (evalCase.expect.selectedProfileId !== undefined) {
    const actual = proposalSelectedId(proposal);
    if (evalCase.expect.selectedProfileId === null) {
      fields.push({
        field: "selectedProfileId",
        ok: actual === undefined,
        expected: "(absent)",
        actual: actual ?? "(absent)",
      });
    } else if (Array.isArray(evalCase.expect.selectedProfileId)) {
      const allowedIds = evalCase.expect.selectedProfileId;
      const ok =
        actual === undefined ||
        (actual !== undefined && allowedIds.includes(actual));
      // For prepare_study, require a hit; for clarify, absence is ok when listed empty-ish.
      const requireId = proposal.kind === "prepare_study";
      fields.push({
        field: "selectedProfileId",
        ok: requireId ? Boolean(actual && allowedIds.includes(actual)) : ok,
        expected: allowedIds.join("|") || "(any/absent)",
        actual: actual ?? "(absent)",
      });
    } else {
      const want = evalCase.expect.selectedProfileId as string;
      fields.push({
        field: "selectedProfileId",
        ok: actual === want,
        expected: want,
        actual: actual ?? "(absent)",
      });
    }
  }

  if (evalCase.expect.questionMatch && proposal.kind === "clarify") {
    const joined = proposal.questions.join(" | ");
    fields.push({
      field: "questionMatch",
      ok: evalCase.expect.questionMatch.test(joined),
      expected: String(evalCase.expect.questionMatch),
      actual: joined.slice(0, 160),
    });
  } else if (evalCase.expect.questionMatch && proposal.kind !== "clarify") {
    // Only required when the model chose clarify; if kind already failed, skip soft fail.
    if (allowed.length === 1 && allowed[0] === "clarify") {
      fields.push({
        field: "questionMatch",
        ok: false,
        expected: String(evalCase.expect.questionMatch),
        actual: `(kind=${proposal.kind})`,
      });
    }
  }

  // Board-update special: As 7d 2c
  if (evalCase.id === "update-board") {
    const board =
      proposal.kind === "update_study"
        ? proposal.board ?? proposal.intent.board
        : undefined;
    const normalized = (board ?? "").replace(/,/g, " ").replace(/\s+/g, " ").trim();
    fields.push({
      field: "board",
      ok: /^As\s+7d\s+2c$/i.test(normalized),
      expected: "As 7d 2c",
      actual: board ?? "(absent)",
    });
  }

  return {
    id: evalCase.id,
    ok: fields.every((f) => f.ok),
    fields,
  };
}

export interface LiveEvalSummary {
  total: number;
  passed: number;
  failed: number;
  fieldHits: number;
  fieldTotal: number;
  fieldAccuracy: number;
  cases: CaseScore[];
}

export function summarizeLiveEval(scores: readonly CaseScore[]): LiveEvalSummary {
  let fieldHits = 0;
  let fieldTotal = 0;
  for (const score of scores) {
    for (const field of score.fields) {
      fieldTotal += 1;
      if (field.ok) fieldHits += 1;
    }
  }
  const passed = scores.filter((s) => s.ok).length;
  return {
    total: scores.length,
    passed,
    failed: scores.length - passed,
    fieldHits,
    fieldTotal,
    fieldAccuracy: fieldTotal === 0 ? 0 : fieldHits / fieldTotal,
    cases: [...scores],
  };
}
