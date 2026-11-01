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
  type StudySetupIntent,
  type StudySetupPreferences,
} from "../setup";
import {
  matchRangeProfiles,
  openSizeFromActions,
  type RangeProfile,
  type RangeProfileCatalogue,
  type RangeProfileQuery,
} from "../profiles";
import type { SpotDraft } from "../types";
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
 * and shared merge/derive helpers. Never trusts model-emitted range weights.
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
      return incompleteResult({
        draftRevision,
        summary: matched.summary,
        missing: matched.missing,
        conflicts: matched.conflicts,
      });
    }
    profile = matched.profile;
  }

  // Duplicate with explicit stack vs profile compatibility.
  if (mode === "duplicate" && profile && intent.stackBb !== undefined) {
    if (profile.startingStackBb !== intent.stackBb) {
      // Still allow apply path via merge conflict: explicit vs profile stack.
      // Caller sees the conflict rather than a silent override.
    }
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
  }
  return result;
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

  const match = matchRangeProfiles(query, catalogue.listProfiles());
  if (match.exact.length === 1) {
    return { kind: "ok", profile: match.exact[0]! };
  }
  if (match.exact.length > 1) {
    return ambiguous(match.exact);
  }
  if (match.alternatives.length > 0) {
    const alts = match.alternatives.map((a) => a.profile);
    return {
      kind: "ambiguous",
      summary: [
        "No exact profile match; choose among labelled alternatives",
        ...match.alternatives.map(
          (a) =>
            `${a.profile.id}: ${a.differences.join("; ")}`,
        ),
      ],
      missing: [
        {
          field: "profile",
          message: "Choose a compatible range profile",
          reason: "needs_clarification",
        },
      ],
      conflicts: [
        {
          field: "profile",
          message: "No exact match — alternatives available",
          options: alts.map((p) => p.id),
        },
      ],
    };
  }

  return {
    kind: "missing",
    summary: [match.none ?? "No range profiles matched"],
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
