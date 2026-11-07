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

/** Build a seat×action atom for a range saved from the Build catalogue. */
export function makeUserSavedRange(
  displayName: string,
  range: string,
  options?: { id?: string; dataRevision?: string | number },
): SeatActionRange {
  const name = displayName.trim() || "Saved range";
  return {
    schemaVersion: SEAT_ACTION_SCHEMA_VERSION,
    id: options?.id ?? userSavedRangeId(name),
    dataRevision: options?.dataRevision ?? Date.now().toString(36),
    displayName: name,
    heroPosition: "USER",
    action: "unknown",
    vsAction: "none",
    range,
    provenance: {
      source: "build-catalogue",
      classification: "personal_adjustment",
      notes: "Saved from Build range catalogue",
    },
  };
}
