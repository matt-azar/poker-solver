import type { SeatPlacement } from "./seatActionPlacement";
import {
  SEAT_ACTION_SCHEMA_VERSION,
  type SeatActionRange,
} from "./seatActionTypes";

/** Stable id for a Build-saved range name (overwrites on re-save). */
export function userSavedRangeId(displayName: string): string {
  const slug =
    displayName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "range";
  return `user-saved-${slug}`;
}

export interface MakeUserSavedRangeOptions {
  id?: string;
  dataRevision?: string | number;
  /** File the range under a seat×action folder; defaults to unfiled USER. */
  placement?: SeatPlacement;
}

/** Build a seat×action atom for a range saved from the Build catalogue. */
export function makeUserSavedRange(
  displayName: string,
  range: string,
  options?: MakeUserSavedRangeOptions,
): SeatActionRange {
  const name = displayName.trim() || "Saved range";
  const placement = options?.placement;
  return {
    schemaVersion: SEAT_ACTION_SCHEMA_VERSION,
    id: options?.id ?? userSavedRangeId(name),
    dataRevision: options?.dataRevision ?? Date.now().toString(36),
    displayName: name,
    heroPosition: placement?.heroPosition?.trim().toUpperCase() || "USER",
    villainPosition: placement?.villainPosition?.trim().toUpperCase() || undefined,
    action: placement?.action ?? "unknown",
    vsAction: placement?.vsAction ?? "none",
    range,
    provenance: {
      source: "build-catalogue",
      classification: "personal_adjustment",
      notes: placement
        ? `Saved into ${placement.heroPosition} catalogue folder`
        : "Saved from Build range catalogue",
    },
  };
}
