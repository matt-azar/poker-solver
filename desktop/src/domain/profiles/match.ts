import { openSizeFromActions } from "./parse";
import type {
  MatchAlternative,
  MatchResult,
  PreflopAction,
  ProfileRake,
  RangeProfile,
  RangeProfileQuery,
} from "./types";

function normPos(value: string | undefined): string | undefined {
  return value?.trim().toUpperCase();
}

function positionsAgree(
  profile: RangeProfile,
  query: RangeProfileQuery,
): boolean {
  if (!query.positions) {
    return true;
  }
  const wantOop = normPos(query.positions.oop);
  const wantIp = normPos(query.positions.ip);
  if (wantOop && wantOop !== normPos(profile.positions.oop)) {
    return false;
  }
  if (wantIp && wantIp !== normPos(profile.positions.ip)) {
    return false;
  }
  return true;
}

function formatAgree(profile: RangeProfile, query: RangeProfileQuery): boolean {
  if (query.format === undefined || query.format === "") {
    return true;
  }
  return profile.format === query.format;
}

function stackAgree(profile: RangeProfile, query: RangeProfileQuery): boolean {
  if (query.stackBb === undefined) {
    return true;
  }
  return profile.startingStackBb === query.stackBb;
}

function queryOpenSize(query: RangeProfileQuery): number | undefined {
  if (query.openSizeBb !== undefined) {
    return query.openSizeBb;
  }
  if (query.preflopActions) {
    return openSizeFromActions(query.preflopActions);
  }
  return undefined;
}

function openAgree(profile: RangeProfile, query: RangeProfileQuery): boolean {
  const want = queryOpenSize(query);
  if (want === undefined) {
    return true;
  }
  const got = openSizeFromActions(profile.preflopActions);
  return got === want;
}

function actionSequenceAgree(
  profile: RangeProfile,
  query: RangeProfileQuery,
): boolean {
  if (!query.preflopActions || query.preflopActions.length === 0) {
    return true;
  }
  return actionsEqual(profile.preflopActions, query.preflopActions);
}

function actionsEqual(left: PreflopAction[], right: PreflopAction[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i++) {
    const a = left[i]!;
    const b = right[i]!;
    if (normPos(a.position) !== normPos(b.position) || a.kind !== b.kind) {
      return false;
    }
    const aSize = a.sizeBb;
    const bSize = b.sizeBb;
    if (aSize === undefined && bSize === undefined) {
      continue;
    }
    if (aSize !== bSize) {
      return false;
    }
  }
  return true;
}

function rakeStructuresEqual(
  left: ProfileRake,
  right: Partial<ProfileRake>,
): boolean {
  if (right.known !== undefined && left.known !== right.known) {
    return false;
  }
  if (right.rate !== undefined && left.rate !== right.rate) {
    return false;
  }
  if (right.cap !== undefined && left.cap !== right.cap) {
    return false;
  }
  if (right.collection !== undefined && left.collection !== right.collection) {
    return false;
  }
  return true;
}

function rakeAgree(profile: RangeProfile, query: RangeProfileQuery): boolean {
  if (!query.rake) {
    return true;
  }
  return rakeStructuresEqual(profile.rake, query.rake);
}

function stakesLabelAgree(profile: RangeProfile, query: RangeProfileQuery): boolean {
  if (!query.stakesLabel) {
    return true;
  }
  const label = profile.labels?.stakes?.trim().toUpperCase();
  return label === query.stakesLabel.trim().toUpperCase();
}

/**
 * Key strategic fields that must all agree for an exact match.
 * Stakes alone is never sufficient — see {@link isExactMatch}.
 */
function keyFieldsAgree(profile: RangeProfile, query: RangeProfileQuery): boolean {
  return (
    positionsAgree(profile, query) &&
    formatAgree(profile, query) &&
    stackAgree(profile, query) &&
    openAgree(profile, query) &&
    actionSequenceAgree(profile, query)
  );
}

/**
 * Exact match requires key strategic fields (positions, format, stack, open/action history).
 * Legacy / incomplete profiles are never exact.
 * Stakes label alone never produces an exact match.
 */
export function isExactMatch(profile: RangeProfile, query: RangeProfileQuery): boolean {
  if (profile.legacyPreset) {
    return false;
  }
  // Incomplete strategic metadata cannot claim exactness.
  if (
    profile.format === "unknown" ||
    profile.positions.oop === "unknown" ||
    profile.positions.ip === "unknown" ||
    profile.preflopActions.length === 0
  ) {
    return false;
  }

  // Stakes-only query: never exact.
  const hasStrategicConstraint =
    query.positions !== undefined ||
    query.stackBb !== undefined ||
    query.format !== undefined ||
    queryOpenSize(query) !== undefined ||
    (query.preflopActions !== undefined && query.preflopActions.length > 0);

  if (!hasStrategicConstraint) {
    return false;
  }

  if (!keyFieldsAgree(profile, query)) {
    return false;
  }

  // Optional rake constraint: when the query specifies rake, it must agree for exact.
  if (!rakeAgree(profile, query)) {
    return false;
  }

  // Stakes is a soft filter only when other key fields already agree.
  if (query.stakesLabel && !stakesLabelAgree(profile, query)) {
    return false;
  }

  return true;
}

function collectDifferences(
  profile: RangeProfile,
  query: RangeProfileQuery,
): string[] {
  const differences: string[] = [];

  if (query.positions) {
    const wantOop = normPos(query.positions.oop);
    const wantIp = normPos(query.positions.ip);
    if (wantOop && wantOop !== normPos(profile.positions.oop)) {
      differences.push(`different OOP position (profile ${profile.positions.oop}, query ${query.positions.oop})`);
    }
    if (wantIp && wantIp !== normPos(profile.positions.ip)) {
      differences.push(`different IP position (profile ${profile.positions.ip}, query ${query.positions.ip})`);
    }
  }

  if (query.format !== undefined && query.format !== "" && profile.format !== query.format) {
    differences.push(`different format (profile ${profile.format}, query ${query.format})`);
  }

  if (query.stackBb !== undefined && profile.startingStackBb !== query.stackBb) {
    differences.push(
      `different stack (profile ${profile.startingStackBb}bb, query ${query.stackBb}bb)`,
    );
  }

  const wantOpen = queryOpenSize(query);
  if (wantOpen !== undefined) {
    const gotOpen = openSizeFromActions(profile.preflopActions);
    if (gotOpen !== wantOpen) {
      differences.push(
        `different open size (profile ${gotOpen ?? "none"}bb, query ${wantOpen}bb)`,
      );
    }
  }

  if (
    query.preflopActions &&
    query.preflopActions.length > 0 &&
    !actionsEqual(profile.preflopActions, query.preflopActions)
  ) {
    // Avoid duplicating open-size message when that is the only mismatch.
    const onlyOpenDiff =
      differences.length === 1 && differences[0]!.startsWith("different open size");
    if (!onlyOpenDiff) {
      differences.push("different preflop action history");
    }
  }

  if (query.rake && !rakeStructuresEqual(profile.rake, query.rake)) {
    differences.push("different rake structure");
  }

  if (query.stakesLabel && !stakesLabelAgree(profile, query)) {
    differences.push(
      `different stakes label (profile ${profile.labels?.stakes ?? "none"}, query ${query.stakesLabel})`,
    );
  }

  if (profile.legacyPreset) {
    differences.push("legacy incomplete preset (assumptions unknown)");
  }

  return differences;
}

function isNearMiss(profile: RangeProfile, query: RangeProfileQuery): boolean {
  // Share at least one of: positions, format, open, stack, or stakes label.
  const sharePosition =
    query.positions !== undefined &&
    ((query.positions.oop !== undefined &&
      normPos(query.positions.oop) === normPos(profile.positions.oop)) ||
      (query.positions.ip !== undefined &&
        normPos(query.positions.ip) === normPos(profile.positions.ip)));

  const shareFormat =
    query.format !== undefined &&
    query.format !== "" &&
    profile.format === query.format;

  const wantOpen = queryOpenSize(query);
  const gotOpen = openSizeFromActions(profile.preflopActions);
  const shareOpen = wantOpen !== undefined && gotOpen === wantOpen;

  const shareStack =
    query.stackBb !== undefined && profile.startingStackBb === query.stackBb;

  const shareStakes = query.stakesLabel !== undefined && stakesLabelAgree(profile, query);

  return sharePosition || shareFormat || shareOpen || shareStack || shareStakes;
}

/**
 * Match catalogue profiles against a structured query.
 * Returns exact matches, labelled near-miss alternatives, or a `none` reason.
 * Never silently substitutes a nearby profile as exact.
 */
export function matchRangeProfiles(
  query: RangeProfileQuery,
  catalogue: readonly RangeProfile[],
): MatchResult {
  const exact: RangeProfile[] = [];
  const alternatives: MatchAlternative[] = [];

  for (const profile of catalogue) {
    if (isExactMatch(profile, query)) {
      exact.push(profile);
      continue;
    }
    if (!isNearMiss(profile, query)) {
      continue;
    }
    const differences = collectDifferences(profile, query);
    if (differences.length === 0) {
      // Query only partially constrained; treat as alternative with a generic note
      // rather than silently promoting to exact.
      differences.push("incomplete query constraints for exact match");
    }
    alternatives.push({ profile, differences });
  }

  if (exact.length === 0 && alternatives.length === 0) {
    return {
      exact: [],
      alternatives: [],
      none: "No range profiles matched the query. Import a profile or relax constraints.",
    };
  }

  return { exact, alternatives };
}
