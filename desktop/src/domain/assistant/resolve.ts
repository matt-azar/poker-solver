import {
  DEFAULT_RAKE_ENVIRONMENT,
  DEFAULT_STARTING_STACK_BB,
  createBlankSetupDraft,
  derivePostflopPotAndStacks,
  mergeSetupPatch,
  resolveStartingStackBb,
  seatsForCoVsBbSrp,
  type SetupDraftResult,
  type SetupPatch,
  type SetupProfileRef,
  type StudySetupIntent,
  type StudySetupPreferences,
} from "../setup";
import {
  composeSpotFromSeatActions,
  getSeatActionCatalogue,
  interpolateProfilesByStack,
  loadBundledSeatActions,
  matchRangeProfiles,
  openSizeFromActions,
  pickStackBracket,
  rankNearestNeighbors,
  type RangeProfile,
  type RangeProfileCatalogue,
  type RangeProfileQuery,
} from "../profiles";
import type { SpotDraft } from "../types";
import { validateGeneratedRanges } from "./generatedRanges";
import { profileToMeta, type InterpretProposal, type ProfileMeta } from "./provider";

export interface CatalogueLike {
  listProfiles(): RangeProfile[];
  getProfile(id: string): RangeProfile | undefined;
}

export interface ResolveAssistantProposalArgs {
  proposal: InterpretProposal;
  baseDraft: SpotDraft;
  catalogue: RangeProfileCatalogue | CatalogueLike;
  preferences: StudySetupPreferences;
  draftRevision: number;
  /** Optional mode hint when the proposal intent omits mode. */
  mode?: StudySetupIntent["mode"];
}

/**
 * Resolve a model/fake proposal into a SetupDraftResult using the catalogue
 * and shared merge/derive helpers. Guarded generatedRanges / interpolation are
 * validated here and labelled in provenance — never treated as equilibrium.
 */
export function resolveAssistantProposal(
  args: ResolveAssistantProposalArgs,
): SetupDraftResult {
  const { proposal, preferences, draftRevision } = args;

  if (proposal.kind === "clarify") {
    return incompleteResult({
      draftRevision,
      summary: [
        "Clarification required before applying setup changes",
        ...proposal.questions,
      ],
      missing: [
        {
          field: "profile",
          message: proposal.questions[0] ?? "Clarification required",
          reason: "needs_clarification",
        },
      ],
      conflicts:
        proposal.candidates && proposal.candidates.length > 0
          ? [
              {
                field: "profile",
                message: "Choose a range profile",
                options: proposal.candidates.map((c) => c.id),
              },
            ]
          : [],
    });
  }

  if (proposal.kind === "unsupported") {
    return incompleteResult({
      draftRevision,
      summary: [`Unsupported: ${proposal.message}`],
      missing: [
        {
          field: "request",
          message: proposal.message,
          reason: "unsupported",
        },
      ],
    });
  }

  if (proposal.kind === "unrelated") {
    return incompleteResult({
      draftRevision,
      summary: [`Unrelated: ${proposal.message}`],
      missing: [
        {
          field: "request",
          message: proposal.message,
          reason: "unrelated",
        },
      ],
    });
  }

  const mode =
    args.mode ??
    proposal.intent.mode ??
    (proposal.kind === "prepare_study"
      ? "create"
      : proposal.kind === "duplicate_study"
        ? "duplicate"
        : "edit");

  const rawStackBb = proposal.stackBb ?? proposal.intent.stackBb;
  const rawStakes = proposal.stakesLabel ?? proposal.intent.stakesLabel;
  const intent: StudySetupIntent = {
    ...proposal.intent,
    mode,
    board: proposal.board ?? proposal.intent.board,
    openSizeBb: proposal.openSizeBb ?? proposal.intent.openSizeBb,
    potType: proposal.intent.potType,
    treePreset: proposal.treeEdits ?? proposal.intent.treePreset,
  };

  // Create: silent stack → 100bb; silent rake structure → cEV. Never from NL alone.
  if (mode === "create") {
    const stackResolved = resolveStartingStackBb({
      explicitStackBb: rawStackBb,
      preferenceStackBb: preferences.defaultStackBb,
    });
    intent.stackBb = stackResolved.stackBb;
    intent.stakesLabel = rawStakes?.trim()
      ? rawStakes.trim()
      : DEFAULT_RAKE_ENVIRONMENT;
  } else {
    if (rawStackBb !== undefined) intent.stackBb = rawStackBb;
    if (rawStakes !== undefined) intent.stakesLabel = rawStakes;
  }

  if (
    mode === "create" &&
    !intent.potType &&
    !proposal.selectedProfileId &&
    !proposal.generatedRanges &&
    !proposal.interpolateFromIds
  ) {
    return incompleteResult({
      draftRevision,
      summary: [
        "Pot type / preflop action is required (SRP / 3BP / 4BP) before ranges can be resolved",
      ],
      missing: [
        {
          field: "potType",
          message: "Which pot type — SRP, 3BP, or 4BP?",
          reason: "needs_clarification",
        },
      ],
    });
  }

  // --- Seat×action composition (preferred grain over synthetic pair packs) ---
  if (
    mode === "create" &&
    intent.potType &&
    intent.oopPosition &&
    intent.ipPosition &&
    !proposal.generatedRanges &&
    !proposal.interpolateFromIds
  ) {
    const selectedMeta = proposal.selectedProfileId
      ? args.catalogue.getProfile(proposal.selectedProfileId)
      : undefined;
    const selectedIsSynthetic =
      selectedMeta?.provenance.classification === "synthetic_fixture";
    // Prefer seat×action atoms unless the player explicitly picked a non-synthetic pack.
    if (!proposal.selectedProfileId || selectedIsSynthetic) {
      const seatCat = getSeatActionCatalogue(loadBundledSeatActions);
      const composed = composeSpotFromSeatActions(seatCat.list(), {
        potType: intent.potType,
        oopPosition: intent.oopPosition,
        ipPosition: intent.ipPosition,
        openerPosition: intent.ipPosition,
        openSizeBb: intent.openSizeBb,
        stackBb: intent.stackBb,
      });
      if (composed.oopRange && composed.ipRange) {
        return finalizeGeneratedOrInterpolated({
          args,
          mode,
          intent,
          draftRevision,
          preferences,
          oopRange: composed.oopRange,
          ipRange: composed.ipRange,
          provenanceKind: "seat_action_composed",
          profileRef: {
            id: `seat-action:${composed.oopAtom?.id ?? "oop"}+${composed.ipAtom?.id ?? "ip"}`,
            revision: draftRevision,
            displayName: `Composed ${intent.oopPosition}/${intent.ipPosition} ${intent.potType}`,
            classification: "population_estimate",
          },
          summaryExtra: [
            ...composed.summary,
            "Ranges composed from seat×action pack atoms (user Ranges.zip)",
            selectedIsSynthetic
              ? "Preferred seat×action pack over synthetic paired fixture"
              : "",
          ].filter(Boolean),
        });
      }
    }
  }

  // --- Guarded generation (highest explicit range authority from the model) ---
  if (proposal.generatedRanges) {
    const validated = validateGeneratedRanges(proposal.generatedRanges);
    if (!validated.ok) {
      return incompleteResult({
        draftRevision,
        summary: [`Rejected generated ranges: ${validated.error}`],
        missing: [
          {
            field: "ranges",
            message: validated.error,
            reason: "invalid_generated_ranges",
          },
        ],
      });
    }
    return finalizeGeneratedOrInterpolated({
      args,
      mode,
      intent,
      draftRevision,
      preferences,
      oopRange: validated.oop,
      ipRange: validated.ip,
      provenanceKind: "model_generated",
      profileRef: {
        id: "model-generated",
        revision: draftRevision,
        displayName: "Model-generated ranges",
        classification: "model_generated",
      },
      summaryExtra: [
        `Model-generated ranges (not equilibrium) · OOP≈${validated.oopCombos.toFixed(1)} · IP≈${validated.ipCombos.toFixed(1)} combos`,
        validated.note ?? "Review weights before solving — not a verified GTO pack",
      ],
    });
  }

  // --- Combo-weight interpolation from two reference profiles ---
  if (proposal.interpolateFromIds && proposal.interpolateFromIds.length === 2) {
    const [idA, idB] = proposal.interpolateFromIds;
    const lowRef = args.catalogue.getProfile(idA);
    const highRef = args.catalogue.getProfile(idB);
    if (!lowRef || !highRef) {
      return incompleteResult({
        draftRevision,
        summary: [
          `Interpolation refs not found: ${!lowRef ? idA : ""} ${!highRef ? idB : ""}`.trim(),
        ],
        missing: [
          {
            field: "profile",
            message: "Both interpolateFromIds must exist in the catalogue",
            reason: "profile_not_found",
          },
        ],
      });
    }
    const targetStack = intent.stackBb ?? preferences.defaultStackBb ?? DEFAULT_STARTING_STACK_BB;
    try {
      const blended = interpolateProfilesByStack({
        low: lowRef,
        high: highRef,
        targetStackBb: targetStack,
      });
      return finalizeGeneratedOrInterpolated({
        args,
        mode,
        intent: { ...intent, stackBb: targetStack },
        draftRevision,
        preferences,
        oopRange: blended.oopRange,
        ipRange: blended.ipRange,
        provenanceKind: "interpolated",
        profileRef: {
          id: `interp:${blended.lowId}+${blended.highId}@${targetStack}`,
          revision: draftRevision,
          displayName: `Interpolated ${targetStack}bb (${blended.lowStackBb}–${blended.highStackBb})`,
          classification: "interpolated",
        },
        summaryExtra: [
          `Interpolated ${blended.method} t=${blended.t.toFixed(3)} from ${blended.lowId}@${blended.lowStackBb}bb + ${blended.highId}@${blended.highStackBb}bb → ${targetStack}bb`,
          ...blended.notes,
          "Interpolated weights are not an equilibrium solve — review before trusting",
        ],
      });
    } catch (err) {
      return incompleteResult({
        draftRevision,
        summary: [
          `Interpolation failed: ${err instanceof Error ? err.message : String(err)}`,
        ],
        missing: [
          {
            field: "ranges",
            message: "Could not interpolate reference profiles",
            reason: "interpolation_failed",
          },
        ],
      });
    }
  }

  // Duplicate / update without a profile selection: apply field edits only.
  const needsProfile =
    mode === "create" ||
    Boolean(proposal.selectedProfileId) ||
    Boolean(intent.profileQuery) ||
    Boolean(intent.oopPosition && intent.ipPosition);

  let profile: RangeProfile | undefined;
  if (needsProfile || proposal.selectedProfileId) {
    const matched = resolveProfile({
      selectedProfileId: proposal.selectedProfileId,
      intent,
      catalogue: args.catalogue,
      preferences,
    });
    if (matched.kind !== "ok") {
      // Auto-bracket interpolate when seats/pot/rake allow and stacks straddle.
      const auto = tryAutoStackInterpolation({
        intent,
        catalogue: args.catalogue,
        draftRevision,
      });
      if (auto) {
        return finalizeGeneratedOrInterpolated({
          args,
          mode,
          intent,
          draftRevision,
          preferences,
          oopRange: auto.oopRange,
          ipRange: auto.ipRange,
          provenanceKind: "interpolated",
          profileRef: auto.profileRef,
          summaryExtra: auto.summaryExtra,
        });
      }
      return incompleteResult({
        draftRevision,
        summary: matched.summary,
        missing: matched.missing,
        conflicts: matched.conflicts,
      });
    }
    profile = matched.profile;
  }

  const patch = buildSetupPatch({
    mode,
    intent,
    profile,
    proposal,
    baseDraft: args.baseDraft,
    preferences,
    draftRevision,
  });

  const base =
    mode === "create"
      ? createBlankSetupDraft("create", args.baseDraft)
      : mode === "duplicate"
        ? createBlankSetupDraft("duplicate", args.baseDraft)
        : args.baseDraft;

  const result = mergeSetupPatch(base, patch, preferences);
  if (mode === "create") {
    const stackWasSilent =
      proposal.stackBb === undefined && proposal.intent.stackBb === undefined;
    const rakeWasSilent =
      !(proposal.stakesLabel ?? proposal.intent.stakesLabel)?.trim();
    if (stackWasSilent && intent.stackBb === DEFAULT_STARTING_STACK_BB) {
      result.summary.push(
        `Assumed ${DEFAULT_STARTING_STACK_BB}bb starting stacks (stack depth not specified)`,
      );
    }
    if (rakeWasSilent && intent.stakesLabel === DEFAULT_RAKE_ENVIRONMENT) {
      result.summary.push(
        "Assumed cEV (chip EV / no rake) because no rake structure was specified",
      );
    }
    if (profile?.provenance.classification === "synthetic_fixture") {
      result.summary.push(
        "Catalogue row is a synthetic fixture — import a reliable pack for study-quality ranges",
      );
    }
  }
  return result;
}

function finalizeGeneratedOrInterpolated(args: {
  args: ResolveAssistantProposalArgs;
  mode: StudySetupIntent["mode"];
  intent: StudySetupIntent;
  draftRevision: number;
  preferences: StudySetupPreferences;
  oopRange: string;
  ipRange: string;
  provenanceKind: "model_generated" | "interpolated" | "seat_action_composed";
  profileRef: SetupProfileRef;
  summaryExtra: string[];
}): SetupDraftResult {
  const { mode, intent, draftRevision, preferences } = args;
  const openSizeBb = intent.openSizeBb ?? preferences.defaultOpenSizeBb ?? 2.5;
  const startingStackBb =
    intent.stackBb ?? preferences.defaultStackBb ?? DEFAULT_STARTING_STACK_BB;
  const oop = intent.oopPosition ?? "BB";
  const ip = intent.ipPosition ?? "CO";
  const derived = derivePostflopPotAndStacks({
    startingStackBb,
    openSizeBb,
    openerSeat: ip,
    callerSeat: oop,
  });

  const patch: SetupPatch = {
    mode,
    requestRevision: draftRevision,
    profile: args.profileRef,
    profileId: args.profileRef.id,
    profileRevision: args.profileRef.revision,
    // Top-level ranges keep model_generated / interpolated provenance tags.
    oopRange: args.oopRange,
    ipRange: args.ipRange,
    explicitFields: {
      openSizeBb,
      boardText: intent.board,
      stakesLabel: intent.stakesLabel,
    },
    derived: {
      potBb: derived.potBb,
      stackBb: derived.stackBb,
    },
    provenance: {
      oopRange: args.provenanceKind,
      ipRange: args.provenanceKind,
      pot: "derived",
      stack: "derived",
    },
  };

  const base =
    mode === "create"
      ? createBlankSetupDraft("create", args.args.baseDraft)
      : mode === "duplicate"
        ? createBlankSetupDraft("duplicate", args.args.baseDraft)
        : args.args.baseDraft;

  const result = mergeSetupPatch(base, patch, preferences);
  result.summary.push(...args.summaryExtra);
  result.profile = args.profileRef;
  return result;
}

function tryAutoStackInterpolation(args: {
  intent: StudySetupIntent;
  catalogue: CatalogueLike;
  draftRevision: number;
}): {
  oopRange: string;
  ipRange: string;
  profileRef: SetupProfileRef;
  summaryExtra: string[];
} | null {
  if (!args.intent.oopPosition || !args.intent.ipPosition || args.intent.stackBb === undefined) {
    return null;
  }
  const bracket = pickStackBracket(args.catalogue.listProfiles(), {
    targetStackBb: args.intent.stackBb,
    positions: { oop: args.intent.oopPosition, ip: args.intent.ipPosition },
    potType: args.intent.potType,
    stakesLabel: args.intent.stakesLabel,
  });
  if (!bracket) {
    return null;
  }
  const blended = interpolateProfilesByStack({
    low: bracket.low,
    high: bracket.high,
    targetStackBb: args.intent.stackBb,
  });
  return {
    oopRange: blended.oopRange,
    ipRange: blended.ipRange,
    profileRef: {
      id: `interp:${blended.lowId}+${blended.highId}@${args.intent.stackBb}`,
      revision: args.draftRevision,
      displayName: `Interpolated ${args.intent.stackBb}bb (${blended.lowStackBb}–${blended.highStackBb})`,
      classification: "interpolated",
    },
    summaryExtra: [
      `Auto-interpolated ${blended.method} from nearest stack bracket ${blended.lowId}@${blended.lowStackBb}bb + ${blended.highId}@${blended.highStackBb}bb`,
      ...blended.notes,
      "Interpolated weights are not an equilibrium solve — review before trusting",
    ],
  };
}

/**
 * Direct (non-NL) Stage A+B path: prepare a study from an explicit profile.
 */
export function prepareStudyFromProfile(
  profile: RangeProfile,
  prefs: StudySetupPreferences,
  revision: number,
  board?: string,
): SetupDraftResult {
  const seats = seatsForCoVsBbSrp();
  const oop = profile.positions.oop || seats.oop;
  const ip = profile.positions.ip || seats.ip;
  const openSizeBb =
    openSizeFromActions(profile.preflopActions) ?? prefs.defaultOpenSizeBb ?? 2.5;
  const derived = derivePostflopPotAndStacks({
    startingStackBb: profile.startingStackBb,
    openSizeBb,
    blinds: profile.blinds,
    openerSeat: ip,
    callerSeat: oop,
    anteBb: profile.antes,
  });

  const patch: SetupPatch = {
    mode: "create",
    requestRevision: revision,
    profileId: profile.id,
    profileRevision:
      typeof profile.dataRevision === "number"
        ? profile.dataRevision
        : Number.parseInt(String(profile.dataRevision), 10) || 0,
    profile: {
      id: profile.id,
      revision:
        typeof profile.dataRevision === "number"
          ? profile.dataRevision
          : Number.parseInt(String(profile.dataRevision), 10) || 0,
      displayName: profile.displayName,
      classification: profile.provenance.classification,
    },
    // Ranges + open size from profile; remaining stack comes from derived (not startingStackBb).
    profileFields: {
      oopRange: profile.ranges.oop,
      ipRange: profile.ranges.ip,
      openSizeBb,
    },
    derived: {
      potBb: derived.potBb,
      stackBb: derived.stackBb,
    },
    explicitFields: board
      ? { boardText: board }
      : undefined,
  };

  const base = createBlankSetupDraft("create");
  const result = mergeSetupPatch(base, patch, prefs);
  // Ensure synthetic provenance is visible in the summary for fixtures.
  if (
    profile.provenance.classification === "synthetic_fixture" &&
    !result.summary.some((line) => /synthetic/i.test(line))
  ) {
    result.summary.push(
      `Synthetic fixture profile ${profile.displayName} — not verified population data`,
    );
  }
  return result;
}

type ProfileMatch =
  | { kind: "ok"; profile: RangeProfile }
  | {
      kind: "missing" | "ambiguous";
      summary: string[];
      missing: SetupDraftResult["missing"];
      conflicts: SetupDraftResult["conflicts"];
    };

function resolveProfile(args: {
  selectedProfileId?: string;
  intent: StudySetupIntent;
  catalogue: CatalogueLike;
  preferences: StudySetupPreferences;
}): ProfileMatch {
  const { catalogue, intent, preferences } = args;

  if (args.selectedProfileId) {
    const hit = catalogue.getProfile(args.selectedProfileId);
    if (!hit) {
      return {
        kind: "missing",
        summary: [`Profile id ${args.selectedProfileId} was not found in the catalogue`],
        missing: [
          {
            field: "profile",
            message: `Unknown profile id ${args.selectedProfileId}`,
            reason: "profile_not_found",
          },
        ],
        conflicts: [],
      };
    }
    return { kind: "ok", profile: hit };
  }

  if (intent.profileQuery) {
    const byQuery = findProfilesByQuery(intent.profileQuery, catalogue.listProfiles());
    if (byQuery.length === 1) {
      return { kind: "ok", profile: byQuery[0]! };
    }
    if (byQuery.length > 1) {
      return ambiguous(byQuery);
    }
  }

  if (preferences.defaultProfileId && intent.mode === "create") {
    const fromPref = catalogue.getProfile(preferences.defaultProfileId);
    // Only auto-use default when positions (if any) agree.
    if (
      fromPref &&
      positionsCompatible(fromPref, intent.oopPosition, intent.ipPosition)
    ) {
      // Still require strategic query match when the user supplied constraints.
      if (!intent.oopPosition && !intent.ipPosition && !intent.stakesLabel) {
        return { kind: "ok", profile: fromPref };
      }
    }
  }

  const query = intentToQuery(intent);
  const hasConstraint =
    query.positions !== undefined ||
    query.stakesLabel !== undefined ||
    query.openSizeBb !== undefined ||
    query.stackBb !== undefined ||
    (query.preflopActions !== undefined && query.preflopActions.length > 0);

  if (!hasConstraint) {
    return {
      kind: "missing",
      summary: ["No profile selected and no matching constraints were provided"],
      missing: [
        {
          field: "profile",
          message: "Select a range profile",
          reason: "profile_missing",
        },
      ],
      conflicts: [],
    };
  }

  const listed = catalogue.listProfiles();
  const match = matchRangeProfiles(query, listed);
  if (match.exact.length === 1) {
    return { kind: "ok", profile: preferNonSynthetic(match.exact)[0]! };
  }
  if (match.exact.length > 1) {
    return ambiguous(preferNonSynthetic(match.exact));
  }

  const neighbors = rankNearestNeighbors(query, listed, 6);
  if (match.alternatives.length > 0 || neighbors.length > 0) {
    const alts = preferNonSynthetic(match.alternatives.map((a) => a.profile));
    const neighborLines = neighbors.map(
      (n) =>
        `near ${n.profile.id} (Δ=${n.distance.toFixed(1)}): ${n.reasons.join("; ") || "close"}`,
    );
    const altLines = match.alternatives.map(
      (a) => `${a.profile.id}: ${a.differences.join("; ")}`,
    );
    const options = [
      ...alts.map((p) => p.id),
      ...neighbors.map((n) => n.profile.id),
    ].filter((id, index, arr) => arr.indexOf(id) === index);
    return {
      kind: "ambiguous",
      summary: [
        "No exact profile match; nearest catalogue rows:",
        ...altLines,
        ...neighborLines,
        "Import a reliable pack, pick a neighbor, or ask the assistant to generate/interpolate ranges",
      ],
      missing: [
        {
          field: "profile",
          message: "Select a compatible range profile or import one",
          reason: "needs_clarification",
        },
      ],
      conflicts: [
        {
          field: "profile",
          message: "No exact match — nearest neighbors available",
          options,
        },
      ],
    };
  }

  return {
    kind: "missing",
    summary: [
      match.none ?? "No range profiles matched",
      "Import a reliable paired profile or request guarded model-generated ranges",
    ],
    missing: [
      {
        field: "profile",
        message: match.none ?? "No matching range profile",
        reason: "profile_missing",
      },
    ],
    conflicts: [],
  };
}

/** Prefer imported / equilibrium rows over synthetic demos when tied. */
function preferNonSynthetic(profiles: RangeProfile[]): RangeProfile[] {
  const preferred = profiles.filter(
    (p) => p.provenance.classification !== "synthetic_fixture",
  );
  return preferred.length > 0 ? preferred : profiles;
}

function ambiguous(profiles: RangeProfile[]): ProfileMatch {
  return {
    kind: "ambiguous",
    summary: [
      "Multiple profiles match — choose one",
      ...profiles.map((p) => p.id),
    ],
    missing: [
      {
        field: "profile",
        message: "Multiple matching profiles",
        reason: "needs_clarification",
      },
    ],
    conflicts: [
      {
        field: "profile",
        message: "Multiple matching profiles",
        options: profiles.map((p) => p.id),
      },
    ],
  };
}

function findProfilesByQuery(
  query: string,
  profiles: readonly RangeProfile[],
): RangeProfile[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return [];
  }
  const exactId = profiles.filter((p) => p.id.toLowerCase() === q);
  if (exactId.length > 0) {
    return exactId;
  }
  return profiles.filter(
    (p) =>
      p.id.toLowerCase().includes(q) ||
      p.displayName.toLowerCase().includes(q),
  );
}

function positionsCompatible(
  profile: RangeProfile,
  oop?: string,
  ip?: string,
): boolean {
  if (oop && profile.positions.oop.toUpperCase() !== oop.toUpperCase()) {
    return false;
  }
  if (ip && profile.positions.ip.toUpperCase() !== ip.toUpperCase()) {
    return false;
  }
  return true;
}

function intentToQuery(intent: StudySetupIntent): RangeProfileQuery {
  const query: RangeProfileQuery = {};
  if (intent.oopPosition || intent.ipPosition) {
    query.positions = {};
    if (intent.oopPosition) query.positions.oop = intent.oopPosition;
    if (intent.ipPosition) query.positions.ip = intent.ipPosition;
  }
  if (intent.stakesLabel) query.stakesLabel = intent.stakesLabel;
  if (intent.potType) query.potType = intent.potType;
  if (intent.openSizeBb !== undefined) query.openSizeBb = intent.openSizeBb;
  // Never treat rake/stakes labels as stack. Stack comes from intent (default 100bb on create).
  if (intent.stackBb !== undefined && intent.mode !== "duplicate") {
    query.stackBb = intent.stackBb;
  }
  return query;
}

function buildSetupPatch(args: {
  mode: StudySetupIntent["mode"];
  intent: StudySetupIntent;
  profile?: RangeProfile;
  proposal: Extract<
    InterpretProposal,
    { kind: "prepare_study" | "update_study" | "duplicate_study" }
  >;
  baseDraft: SpotDraft;
  preferences: StudySetupPreferences;
  draftRevision: number;
}): SetupPatch {
  const { mode, intent, profile, draftRevision } = args;
  const patch: SetupPatch = {
    mode,
    requestRevision: draftRevision,
  };

  const explicit: NonNullable<SetupPatch["explicitFields"]> = {};
  const tree = intent.treePreset;
  if (tree) {
    for (const key of [
      "oopBets",
      "ipBets",
      "oopFlop",
      "ipFlop",
      "oopTurn",
      "ipTurn",
      "oopRiver",
      "ipRiver",
      "oopDonk",
    ] as const) {
      if (tree[key] !== undefined) {
        explicit[key] = tree[key];
      }
    }
    if (tree.potCap !== undefined) explicit.potCap = tree.potCap;
    if (tree.noThreeBet !== undefined) explicit.noThreeBet = tree.noThreeBet;
    if (tree.geometric !== undefined) explicit.geometric = tree.geometric;
    if (tree.maxRaises !== undefined) explicit.maxRaises = tree.maxRaises;
  }
  if (intent.board) {
    explicit.boardText = intent.board;
  }
  if (intent.stakesLabel) {
    explicit.stakesLabel = intent.stakesLabel;
  }
  // Starting-stack intent drives catalogue matching. The draft `stack` field is
  // remaining stack after preflop (from derived). Only write stackBb into the
  // draft patch for duplicate/edit overrides or create-without-profile.
  if (intent.stackBb !== undefined) {
    if (mode === "duplicate" || mode === "edit" || (mode === "create" && !profile)) {
      explicit.stackBb = intent.stackBb;
    }
  }
  if (intent.openSizeBb !== undefined) {
    explicit.openSizeBb = intent.openSizeBb;
  }
  if (args.proposal.fieldEdits) {
    for (const [key, value] of Object.entries(args.proposal.fieldEdits)) {
      if (value !== undefined) {
        (explicit as Record<string, unknown>)[key] = value;
      }
    }
  }

  if (Object.keys(explicit).length > 0) {
    patch.explicitFields = explicit;
  }

  if (profile) {
    const openSizeBb =
      openSizeFromActions(profile.preflopActions) ??
      intent.openSizeBb ??
      args.preferences.defaultOpenSizeBb;
    const seats =
      profile.positions.oop.toUpperCase() === "BB" &&
      profile.positions.ip.toUpperCase() === "CO"
        ? seatsForCoVsBbSrp()
        : { oop: profile.positions.oop, ip: profile.positions.ip };

    patch.profileId = profile.id;
    patch.profileRevision =
      typeof profile.dataRevision === "number"
        ? profile.dataRevision
        : Number.parseInt(String(profile.dataRevision), 10) || 0;
    patch.profile = {
      id: profile.id,
      revision: patch.profileRevision ?? 0,
      displayName: profile.displayName,
      classification: profile.provenance.classification,
    };
    patch.profileFields = {
      oopRange: profile.ranges.oop,
      ipRange: profile.ranges.ip,
      openSizeBb,
    };

    const startingStackBb =
      mode === "duplicate" && intent.stackBb !== undefined
        ? intent.stackBb
        : profile.startingStackBb;

    if (mode === "duplicate" && intent.stackBb !== undefined) {
      // Recheck compatibility: explicit starting stack vs profile starting stack.
      patch.profileFields.stackBb = profile.startingStackBb;
      if (profile.startingStackBb !== intent.stackBb) {
        // Conflict surfaces via mergeSetupPatch; do not silently re-derive.
      } else if (openSizeBb !== undefined) {
        const derived = derivePostflopPotAndStacks({
          startingStackBb,
          openSizeBb,
          blinds: profile.blinds,
          openerSeat: seats.ip,
          callerSeat: seats.oop,
          anteBb: profile.antes,
        });
        patch.derived = {
          potBb: derived.potBb,
          stackBb: derived.stackBb,
        };
      }
    } else if (openSizeBb !== undefined) {
      const derived = derivePostflopPotAndStacks({
        startingStackBb,
        openSizeBb,
        blinds: profile.blinds,
        openerSeat: seats.ip,
        callerSeat: seats.oop,
        anteBb: profile.antes,
      });
      patch.derived = {
        potBb: derived.potBb,
        stackBb: derived.stackBb,
      };
    }

  } else if (intent.stackBb !== undefined && mode === "duplicate") {
    // Stack-only duplicate without reloading a profile.
    patch.explicitFields = {
      ...(patch.explicitFields ?? {}),
      stackBb: intent.stackBb,
      stack: intent.stackBb,
    };
  }

  return patch;
}

function incompleteResult(args: {
  draftRevision: number;
  summary: string[];
  missing?: SetupDraftResult["missing"];
  conflicts?: SetupDraftResult["conflicts"];
}): SetupDraftResult {
  return {
    ok: false,
    draftPatch: {},
    provenance: {},
    conflicts: args.conflicts ?? [],
    missing: args.missing ?? [],
    summary: args.summary,
    canSolve: false,
    profile: null,
    requestRevision: args.draftRevision,
  };
}

/** Build ProfileMeta rows for a provider request from a catalogue. */
export function catalogueProfileMetas(
  catalogue: CatalogueLike,
): ProfileMeta[] {
  return catalogue.listProfiles().map((p) => profileToMeta(p));
}
