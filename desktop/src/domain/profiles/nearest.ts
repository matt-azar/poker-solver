import { potTypeFromActions } from "../setup/derive";
import { openSizeFromActions } from "./parse";
import { normalizeRakeEnvironmentLabel } from "./match";
import type { RangeProfile, RangeProfileQuery } from "./types";

export interface NeighborScore {
  profile: RangeProfile;
  /** Lower is closer. */
  distance: number;
  reasons: string[];
}

function normPos(value: string | undefined): string | undefined {
  return value?.trim().toUpperCase();
}

/**
 * Rank catalogue rows by strategic nearness to a query.
 * Exact matches get distance 0; stack gaps dominate when seats/pot agree.
 */
export function rankNearestNeighbors(
  query: RangeProfileQuery,
  catalogue: readonly RangeProfile[],
  limit = 8,
): NeighborScore[] {
  const scored: NeighborScore[] = [];

  for (const profile of catalogue) {
    if (profile.legacyPreset) {
      continue;
    }
    const reasons: string[] = [];
    let distance = 0;

    const wantOop = normPos(query.positions?.oop);
    const wantIp = normPos(query.positions?.ip);
    const gotOop = normPos(profile.positions.oop);
    const gotIp = normPos(profile.positions.ip);
    if (wantOop && gotOop && wantOop !== gotOop) {
      distance += 50;
      reasons.push(`OOP ${gotOop}≠${wantOop}`);
    }
    if (wantIp && gotIp && wantIp !== gotIp) {
      distance += 50;
      reasons.push(`IP ${gotIp}≠${wantIp}`);
    }

    if (query.potType) {
      const got = potTypeFromActions(profile.preflopActions);
      if (got !== query.potType) {
        distance += 40;
        reasons.push(`pot ${got ?? "?"}≠${query.potType}`);
      }
    }

    if (query.stakesLabel) {
      const want = normalizeRakeEnvironmentLabel(query.stakesLabel);
      const got = normalizeRakeEnvironmentLabel(profile.labels?.stakes);
      if (want !== got) {
        distance += 15;
        reasons.push(`rake ${got}≠${want}`);
      }
    }

    if (query.format && query.format !== "" && profile.format !== query.format) {
      distance += 10;
      reasons.push(`format ${profile.format}≠${query.format}`);
    }

    if (query.stackBb !== undefined) {
      const gap = Math.abs(profile.startingStackBb - query.stackBb);
      distance += gap;
      if (gap > 0) {
        reasons.push(`stack Δ${gap}bb`);
      }
    }

    const wantOpen = query.openSizeBb;
    if (wantOpen !== undefined) {
      const gotOpen = openSizeFromActions(profile.preflopActions);
      if (gotOpen !== undefined && gotOpen !== wantOpen) {
        distance += Math.abs(gotOpen - wantOpen) * 5;
        reasons.push(`open ${gotOpen}≠${wantOpen}`);
      }
    }

    // Prefer non-synthetic / imported strategic packs when distances tie.
    if (profile.provenance.classification === "synthetic_fixture") {
      distance += 0.5;
      reasons.push("synthetic fixture");
    }

    scored.push({ profile, distance, reasons });
  }

  scored.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    return a.profile.id.localeCompare(b.profile.id);
  });
  return scored.slice(0, Math.max(0, limit));
}

/** True when two neighbors straddle the target stack (inclusive). */
export function neighborsStraddleStack(
  low: RangeProfile,
  high: RangeProfile,
  targetStackBb: number,
): boolean {
  const a = Math.min(low.startingStackBb, high.startingStackBb);
  const b = Math.max(low.startingStackBb, high.startingStackBb);
  return a <= targetStackBb && targetStackBb <= b && a !== b;
}
