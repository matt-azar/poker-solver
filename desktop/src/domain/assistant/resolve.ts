import {
  DEFAULT_RAKE_ENVIRONMENT,
  DEFAULT_STARTING_STACK_BB,
  createBlankSetupDraft,
  derivePostflopPotAndStacks,
  mergeSetupPatch,
  profileActionsToSetupActions,
  resolveStartingStackBb,
  seatsForCoVsBbSrp,
  type PreflopAction,
  type SetupDraftResult,
  type SetupFieldProvenance,
  type SetupPatch,
  type SetupProfileRef,
  type StudySetupIntent,
  type StudySetupPreferences,
} from "../setup";
import {
  validateProposedFieldBag,
  type LimitedSetupField,
} from "../setup/fieldLimits";
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

/** Range fields + provenance supplied to the canonical planner (never bypasses it). */
interface RangeSource {
  oopRange: string;
  ipRange: string;
  provenanceKind: Extract<
    SetupFieldProvenance,
    | "model_generated"
    | "interpolated"
    | "seat_action_composed"
    | "selected_profile"
  >;
  profileRef: SetupProfileRef;
  summaryExtra: string[];
  /** When present, derive uses this profile's blinds/antes/actions. */
  profile?: RangeProfile;
  /** Setup-shaped preflop history for pot/stack derivation. */
  setupActions?: PreflopAction[];
}

/**
 * Resolve a model/fake proposal into a SetupDraftResult using the catalogue
 * and shared merge/derive helpers. Guarded generatedRanges / interpolation are
 * validated here and labelled in provenance — never treated as equilibrium.
 *
 * All prepare / update / duplicate kinds enter one planner (`buildSetupPatch` →
 * `mergeSetupPatch`). Range sourcing only supplies range fields + provenance.
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

  let rangeSource: RangeSource | undefined;
  let profile: RangeProfile | undefined;

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
        rangeSource = {
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
          setupActions: intent.preflopActions,
        };
      }
    }
  }

  // --- Guarded generation (highest explicit range authority from the model) ---
  if (!rangeSource && proposal.generatedRanges) {
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
    rangeSource = {
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
      setupActions: intent.preflopActions,
    };
  }

  // --- Combo-weight interpolation from two reference profiles ---
  if (
    !rangeSource &&
    proposal.interpolateFromIds &&
    proposal.interpolateFromIds.length === 2
  ) {
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
    const targetStack =
      intent.stackBb ?? preferences.defaultStackBb ?? DEFAULT_STARTING_STACK_BB;
    try {
      const blended = interpolateProfilesByStack({
        low: lowRef,
        high: highRef,
        targetStackBb: targetStack,
      });
      intent.stackBb = targetStack;
      rangeSource = {
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
        // Prefer the lower bracket's action history when both share the line.
        profile: lowRef,
        setupActions:
          intent.preflopActions ??
          profileActionsToSetupActions(lowRef.preflopActions),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const incompatible = /incompatible interpolation|unsupported extrapolation/i.test(
        message,
      );
      return incompleteResult({
        draftRevision,
        summary: [`Interpolation failed: ${message}`],
        conflicts: incompatible
          ? [
              {
                field: "interpolateFromIds",
                message,
              },
            ]
          : undefined,
        missing: incompatible
          ? undefined
          : [
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
    !rangeSource &&
    (mode === "create" ||
      Boolean(proposal.selectedProfileId) ||
      Boolean(intent.profileQuery) ||
      Boolean(intent.oopPosition && intent.ipPosition));

  if (needsProfile || (!rangeSource && proposal.selectedProfileId)) {
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
        rangeSource = auto;
      } else {
        return incompleteResult({
          draftRevision,
          summary: matched.summary,
          missing: matched.missing,
          conflicts: matched.conflicts,
        });
      }
    } else {
      profile = matched.profile;
    }
  }

  const patch = buildSetupPatch({
    mode,
    intent,
    profile,
    rangeSource,
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
  if (rangeSource) {
    result.summary.push(...rangeSource.summaryExtra);
    result.profile = rangeSource.profileRef;
  }

  // A07: invalid proposed numbers are conflicts (ok:false), not incomplete canSolve.
  const invalidFields = collectInvalidProposedFields(proposal, result);
  if (invalidFields.length > 0) {
    result.conflicts.push(...invalidFields);
    result.ok = false;
    result.canSolve = false;
    result.draftPatch = {};
    result.summary.push(
      ...invalidFields.map((c) => `Invalid ${c.field}: ${c.message}`),
    );
    return result;
  }

  annotateRangeSourceVsSolveRake({
    result,
    intent,
    profile,
    rangeSource,
    proposal,
    baseDraft: args.baseDraft,
  });

  if (intent.unsupported && intent.unsupported.length > 0) {
    for (const item of intent.unsupported) {
      result.summary.push(`Unsupported field/request: ${item}`);
      result.missing.push({
        field: "unsupported",
        message: item,
        reason: "unsupported",
      });
    }
    result.ok = false;
    result.canSolve = false;
  }
  if (mode === "create") {
    const stackWasSilent =
      proposal.stackBb === undefined && proposal.intent.stackBb === undefined;
    const rangeSourceRakeSilent =
      !(proposal.stakesLabel ?? proposal.intent.stakesLabel)?.trim();
    if (stackWasSilent && intent.stackBb === DEFAULT_STARTING_STACK_BB) {
      result.summary.push(
        `Assumed ${DEFAULT_STARTING_STACK_BB}bb starting stacks (stack depth not specified)`,
      );
    }
    if (rangeSourceRakeSilent && intent.stakesLabel === DEFAULT_RAKE_ENVIRONMENT) {
      result.summary.push(
        "Assumed range-source environment cEV (chip EV / no rake structure) because none was specified — solve rake unchanged",
      );
    }
    const classification =
      profile?.provenance.classification ??
      rangeSource?.profileRef.classification;
    if (classification === "synthetic_fixture") {
      result.summary.push(
        "Catalogue row is a synthetic fixture — import a reliable pack for study-quality ranges",
      );
    }
  }
  return result;
}

function collectInvalidProposedFields(
  proposal: Extract<
    InterpretProposal,
    { kind: "prepare_study" | "update_study" | "duplicate_study" }
  >,
  result: SetupDraftResult,
): SetupDraftResult["conflicts"] {
  const bag: Partial<Record<LimitedSetupField, unknown>> = {
    ...(proposal.fieldEdits ?? {}),
  };
  // Also check values that landed on the patch from tree/intent merges.
  for (const key of [
    "pot",
    "stack",
    "iterations",
    "threads",
    "memoryMib",
    "samples",
    "maxRaises",
    "mergeThresholdPct",
    "potCap",
    "rakeRate",
    "rakeCap",
  ] as const) {
    if (bag[key] === undefined && result.draftPatch[key] !== undefined) {
      bag[key] = result.draftPatch[key];
    }
  }
  return validateProposedFieldBag(bag);
}

/**
 * A03: range-source environment (catalogue/provenance) is independent of
 * engine solve rake. Never copy profile.rake onto the draft; report both.
 */
function annotateRangeSourceVsSolveRake(args: {
  result: SetupDraftResult;
  intent: StudySetupIntent;
  profile?: RangeProfile;
  rangeSource?: RangeSource;
  proposal: Extract<
    InterpretProposal,
    { kind: "prepare_study" | "update_study" | "duplicate_study" }
  >;
  baseDraft: SpotDraft;
}): void {
  const { result, intent, profile, rangeSource, proposal, baseDraft } = args;
  const rangeSourceLabel =
    intent.stakesLabel ??
    profile?.labels?.stakes ??
    rangeSource?.profile?.labels?.stakes;
  if (rangeSourceLabel) {
    result.provenance.rangeSourceEnvironment =
      result.provenance.stakesLabel ??
      (intent.stakesLabel ? "explicit_request" : "selected_profile");
    result.summary.push(
      `Range-source environment: ${rangeSourceLabel} (catalogue matching / provenance only — does not change solve rake)`,
    );
  }

  const edits = proposal.fieldEdits;
  const solveRakeEdited =
    edits?.rakeRate !== undefined || edits?.rakeCap !== undefined;
  const nextRate =
    result.draftPatch.rakeRate !== undefined
      ? result.draftPatch.rakeRate
      : baseDraft.rakeRate;
  const nextCap =
    result.draftPatch.rakeCap !== undefined
      ? result.draftPatch.rakeCap
      : baseDraft.rakeCap;

  if (solveRakeEdited) {
    result.provenance.rakeRate =
      result.provenance.rakeRate ?? "explicit_request";
    result.provenance.rakeCap =
      result.provenance.rakeCap ?? "explicit_request";
    const cleared = nextRate === 0 && nextCap === 0;
    result.summary.push(
      cleared
        ? `Solve rake cleared (engine rate=0, cap=0) — ranges unchanged unless also requested`
        : `Solve rake set to rate=${nextRate}, cap=${nextCap} (engine; independent of range-source environment)`,
    );
  } else if (rangeSource || profile || rangeSourceLabel) {
    // Pin current engine rake onto the patch for create blanks so loading
    // ranges cannot wipe a raked sim via DEFAULT_SPOT zeros.
    if (result.draftPatch.rakeRate === undefined) {
      result.draftPatch.rakeRate = baseDraft.rakeRate;
      result.provenance.rakeRate = "default";
    }
    if (result.draftPatch.rakeCap === undefined) {
      result.draftPatch.rakeCap = baseDraft.rakeCap;
      result.provenance.rakeCap = "default";
    }
    result.summary.push(
      `Solve rake unchanged: rate=${baseDraft.rakeRate}, cap=${baseDraft.rakeCap} (engine; independent of range-source)`,
    );
  }
}

function tryAutoStackInterpolation(args: {
  intent: StudySetupIntent;
  catalogue: CatalogueLike;
  draftRevision: number;
}): RangeSource | null {
  if (
    !args.intent.oopPosition ||
    !args.intent.ipPosition ||
    args.intent.stackBb === undefined
  ) {
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
    provenanceKind: "interpolated",
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
    profile: bracket.low,
    setupActions:
      args.intent.preflopActions ??
      profileActionsToSetupActions(bracket.low.preflopActions),
  };
}

/**
 * Direct (non-NL) Stage A+B path: prepare a study from an explicit profile.
 * Profile rake/stakes labels are range-source provenance only — never copied
 * onto engine solve rake. Pass `currentDraft` so an existing solve rake is preserved.
 */
export function prepareStudyFromProfile(
  profile: RangeProfile,
  prefs: StudySetupPreferences,
  revision: number,
  board?: string,
  currentDraft?: SpotDraft,
): SetupDraftResult {
  const seats = seatsForCoVsBbSrp();
  const oop = profile.positions.oop || seats.oop;
  const ip = profile.positions.ip || seats.ip;
  const openSizeBb =
    openSizeFromActions(profile.preflopActions) ?? prefs.defaultOpenSizeBb ?? 2.5;
  const setupActions = profileActionsToSetupActions(profile.preflopActions);
  const derived = derivePostflopPotAndStacks({
    startingStackBb: profile.startingStackBb,
    openSizeBb,
    blinds: profile.blinds,
    openerSeat: ip,
    callerSeat: oop,
    anteBb: profile.antes,
    actions: setupActions,
  });

  const live = currentDraft;
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
    // Deliberately omit profile.rake — range-source ≠ solve rake (A03).
    profileFields: {
      oopRange: profile.ranges.oop,
      ipRange: profile.ranges.ip,
      openSizeBb,
    },
    derived: derived.incompleteReason
      ? undefined
      : {
          potBb: derived.potBb,
          stackBb: derived.stackBb,
        },
    explicitFields: board ? { boardText: board } : undefined,
    // Preserve engine solve rake from the live sim (never copy profile.rake).
    ...(live
      ? {
          rakeRate: live.rakeRate,
          rakeCap: live.rakeCap,
          provenance: { rakeRate: "default" as const, rakeCap: "default" as const },
        }
      : {}),
  };

  const base = live
    ? createBlankSetupDraft("create", live)
    : createBlankSetupDraft("create");
  const result = mergeSetupPatch(base, patch, prefs);
  const stakes = profile.labels?.stakes;
  if (stakes) {
    result.provenance.rangeSourceEnvironment = "selected_profile";
    result.summary.push(
      `Range-source environment: ${stakes} (catalogue matching / provenance only — does not change solve rake)`,
    );
  }
  const rate = result.draftPatch.rakeRate ?? live?.rakeRate ?? 0;
  const cap = result.draftPatch.rakeCap ?? live?.rakeCap ?? 0;
  result.summary.push(
    `Solve rake unchanged: rate=${rate}, cap=${cap} (engine; profile rake was not applied)`,
  );
  if (derived.incompleteReason) {
    result.summary.push(derived.incompleteReason);
    result.missing.push({
      field: "preflopActions",
      message: derived.incompleteReason,
      reason: "needs_clarification",
    });
    result.ok = false;
    result.canSolve = false;
  }
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

function resolveDeriveActions(args: {
  intent: StudySetupIntent;
  profile?: RangeProfile;
  rangeSource?: RangeSource;
}): PreflopAction[] | undefined {
  if (args.intent.preflopActions && args.intent.preflopActions.length > 0) {
    return args.intent.preflopActions;
  }
  if (args.rangeSource?.setupActions && args.rangeSource.setupActions.length > 0) {
    return args.rangeSource.setupActions;
  }
  if (args.profile?.preflopActions && args.profile.preflopActions.length > 0) {
    return profileActionsToSetupActions(args.profile.preflopActions);
  }
  return undefined;
}

/**
 * Whether this proposal should recompute pot/stack from preflop history.
 * Edit-mode range-only updates must leave pot/stack/bets/solver settings alone.
 */
function shouldDerivePotStack(args: {
  mode: StudySetupIntent["mode"];
  intent: StudySetupIntent;
  profile?: RangeProfile;
  rangeSource?: RangeSource;
  proposal: Extract<
    InterpretProposal,
    { kind: "prepare_study" | "update_study" | "duplicate_study" }
  >;
}): boolean {
  const { mode, intent, profile, rangeSource, proposal } = args;
  // Explicit pot/stack field edits win; do not also derive over them.
  if (
    proposal.fieldEdits?.pot !== undefined ||
    proposal.fieldEdits?.stack !== undefined
  ) {
    return false;
  }
  if (mode === "edit") {
    // Only re-derive on edit when the player supplied preflop history or open size
    // (or selected a profile that carries history). Pure range swaps preserve pot/stack.
    const hasHistory =
      (intent.preflopActions && intent.preflopActions.length > 0) ||
      (rangeSource?.setupActions && rangeSource.setupActions.length > 0) ||
      Boolean(profile);
    const hasOpen = intent.openSizeBb !== undefined;
    return Boolean(hasHistory || hasOpen);
  }
  if (mode === "duplicate") {
    return Boolean(profile) || Boolean(intent.preflopActions?.length);
  }
  // create
  if (profile || (intent.preflopActions && intent.preflopActions.length > 0)) {
    return true;
  }
  // Default SRP derivation only when pot type is SRP (or unspecified with open size).
  // Never invent SRP numbers for an explicit 3BP/4BP without sizes/history.
  if (intent.potType === "3BP" || intent.potType === "4BP") {
    return false;
  }
  return intent.openSizeBb !== undefined || intent.potType === "SRP";
}

function buildSetupPatch(args: {
  mode: StudySetupIntent["mode"];
  intent: StudySetupIntent;
  profile?: RangeProfile;
  rangeSource?: RangeSource;
  proposal: Extract<
    InterpretProposal,
    { kind: "prepare_study" | "update_study" | "duplicate_study" }
  >;
  baseDraft: SpotDraft;
  preferences: StudySetupPreferences;
  draftRevision: number;
}): SetupPatch {
  const { mode, intent, profile, rangeSource, draftRevision } = args;
  const patch: SetupPatch = {
    mode,
    requestRevision: draftRevision,
    provenance: {},
  };

  const explicit: NonNullable<SetupPatch["explicitFields"]> = {};
  const tree = intent.treePreset;
  if (tree) {
    for (const key of [
      "oopBets",
      "ipBets",
      "oopRaises",
      "ipRaises",
      "oopFlop",
      "ipFlop",
      "oopTurn",
      "ipTurn",
      "oopRiver",
      "ipRiver",
      "oopFlopRaises",
      "ipFlopRaises",
      "oopTurnRaises",
      "ipTurnRaises",
      "oopRiverRaises",
      "ipRiverRaises",
      "oopDonk",
      "oopFlopDonk",
      "oopTurnDonk",
      "oopRiverDonk",
    ] as const) {
      if (tree[key] !== undefined) {
        explicit[key] = tree[key];
      }
    }
    if (tree.potCap !== undefined) explicit.potCap = tree.potCap;
    if (tree.noThreeBet !== undefined) explicit.noThreeBet = tree.noThreeBet;
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
    if (mode === "duplicate" || mode === "edit" || (mode === "create" && !profile && !rangeSource)) {
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

  // Range sourcing supplies ranges + provenance into the same planner.
  if (rangeSource) {
    patch.profile = rangeSource.profileRef;
    patch.profileId = rangeSource.profileRef.id;
    patch.profileRevision = rangeSource.profileRef.revision;
    patch.oopRange = rangeSource.oopRange;
    patch.ipRange = rangeSource.ipRange;
    patch.provenance = {
      ...(patch.provenance ?? {}),
      oopRange: rangeSource.provenanceKind,
      ipRange: rangeSource.provenanceKind,
    };
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
      } else if (
        openSizeBb !== undefined &&
        shouldDerivePotStack(args)
      ) {
        applyDerived(patch, {
          startingStackBb,
          openSizeBb,
          blinds: profile.blinds,
          openerSeat: seats.ip,
          callerSeat: seats.oop,
          anteBb: profile.antes,
          actions: resolveDeriveActions(args),
        });
      }
    } else if (openSizeBb !== undefined && shouldDerivePotStack(args)) {
      applyDerived(patch, {
        startingStackBb,
        openSizeBb,
        blinds: profile.blinds,
        openerSeat: seats.ip,
        callerSeat: seats.oop,
        anteBb: profile.antes,
        actions: resolveDeriveActions(args),
      });
    }
  } else if (shouldDerivePotStack(args)) {
    const openSizeBb =
      intent.openSizeBb ?? args.preferences.defaultOpenSizeBb ?? 2.5;
    const startingStackBb =
      intent.stackBb ??
      args.preferences.defaultStackBb ??
      DEFAULT_STARTING_STACK_BB;
    const oop = intent.oopPosition ?? "BB";
    const ip = intent.ipPosition ?? "CO";
    const actions = resolveDeriveActions(args);
    applyDerived(patch, {
      startingStackBb,
      openSizeBb,
      openerSeat: ip,
      callerSeat: oop,
      actions,
      blinds: rangeSource?.profile?.blinds,
      anteBb: rangeSource?.profile?.antes,
    });
  } else if (
    mode === "create" &&
    (intent.potType === "3BP" || intent.potType === "4BP") &&
    !(resolveDeriveActions(args)?.length)
  ) {
    // Ask rather than invent an SRP pot when multi-bet sizes are unknown.
    patch.provenance = {
      ...(patch.provenance ?? {}),
      pot: "unresolved",
      stack: "unresolved",
    };
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

function applyDerived(
  patch: SetupPatch,
  input: Parameters<typeof derivePostflopPotAndStacks>[0],
): void {
  const derived = derivePostflopPotAndStacks(input);
  if (derived.incompleteReason) {
    patch.provenance = {
      ...(patch.provenance ?? {}),
      pot: "unresolved",
      stack: "unresolved",
    };
    return;
  }
  patch.derived = {
    potBb: derived.potBb,
    stackBb: derived.stackBb,
  };
  patch.provenance = {
    ...(patch.provenance ?? {}),
    pot: "derived",
    stack: "derived",
  };
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
