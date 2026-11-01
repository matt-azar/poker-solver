import {
  RANGE_PROFILE_SCHEMA_VERSION,
  type LegacyPresetInput,
  type PreflopAction,
  type PreflopActionKind,
  type ProfileBlinds,
  type ProfileClassification,
  type ProfileLabels,
  type ProfilePositions,
  type ProfileProvenance,
  type ProfileRake,
  type ProfileRanges,
  type RangeProfile,
} from "./types";

export type ParseOk<T> = { ok: true; value: T };
export type ParseErr = { ok: false; error: string };
export type ParseResult<T> = ParseOk<T> | ParseErr;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`RangeProfile.${field} must be a non-empty string`);
  }
  return value;
}

function asOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`RangeProfile.${field} must be a string when present`);
  }
  return value;
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`RangeProfile.${field} must be a finite number`);
  }
  return value;
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`RangeProfile.${field} must be a boolean`);
  }
  return value;
}

function asRevision(value: unknown): string | number {
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new Error("RangeProfile.dataRevision must be a non-empty string or finite number");
}

const ACTION_KINDS: ReadonlySet<string> = new Set([
  "open",
  "call",
  "fold",
  "raise",
  "check",
]);

const CLASSIFICATIONS: ReadonlySet<string> = new Set([
  "equilibrium_model",
  "population_estimate",
  "personal_adjustment",
  "synthetic_fixture",
  "model_generated",
  "interpolated",
  "unknown",
]);

function parsePositions(raw: unknown): ProfilePositions {
  if (!isRecord(raw)) {
    throw new Error("RangeProfile.positions must be an object");
  }
  return {
    oop: asString(raw.oop, "positions.oop"),
    ip: asString(raw.ip, "positions.ip"),
  };
}

function parseBlinds(raw: unknown): ProfileBlinds {
  if (!isRecord(raw)) {
    throw new Error("RangeProfile.blinds must be an object");
  }
  return {
    sb: asNumber(raw.sb, "blinds.sb"),
    bb: asNumber(raw.bb, "blinds.bb"),
  };
}

function parseRake(raw: unknown): ProfileRake {
  if (!isRecord(raw)) {
    throw new Error("RangeProfile.rake must be an object");
  }
  return {
    rate: asNumber(raw.rate, "rake.rate"),
    cap: asNumber(raw.cap, "rake.cap"),
    collection: asString(raw.collection, "rake.collection"),
    known: asBoolean(raw.known, "rake.known"),
  };
}

function parseLabels(raw: unknown): ProfileLabels | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!isRecord(raw)) {
    throw new Error("RangeProfile.labels must be an object when present");
  }
  return {
    stakes: asOptionalString(raw.stakes, "labels.stakes"),
    site: asOptionalString(raw.site, "labels.site"),
    pool: asOptionalString(raw.pool, "labels.pool"),
    intendedUse: asOptionalString(raw.intendedUse, "labels.intendedUse"),
  };
}

function parseProvenance(raw: unknown): ProfileProvenance {
  if (!isRecord(raw)) {
    throw new Error("RangeProfile.provenance must be an object");
  }
  const classification = asString(raw.classification, "provenance.classification");
  if (!CLASSIFICATIONS.has(classification)) {
    throw new Error(
      `RangeProfile.provenance.classification must be one of ${[...CLASSIFICATIONS].join(", ")}`,
    );
  }
  return {
    source: asString(raw.source, "provenance.source"),
    classification: classification as ProfileClassification,
    notes: asOptionalString(raw.notes, "provenance.notes"),
  };
}

function parseRanges(raw: unknown): ProfileRanges {
  if (!isRecord(raw)) {
    throw new Error("RangeProfile.ranges must be an object");
  }
  // Preserve exact text (including mixed weights); do not rewrite via rangeText.
  return {
    oop: asString(raw.oop, "ranges.oop"),
    ip: asString(raw.ip, "ranges.ip"),
  };
}

function parsePreflopAction(raw: unknown, index: number): PreflopAction {
  if (!isRecord(raw)) {
    throw new Error(`RangeProfile.preflopActions[${index}] must be an object`);
  }
  const kind = asString(raw.kind, `preflopActions[${index}].kind`);
  if (!ACTION_KINDS.has(kind)) {
    throw new Error(
      `RangeProfile.preflopActions[${index}].kind must be one of ${[...ACTION_KINDS].join(", ")}`,
    );
  }
  const action: PreflopAction = {
    position: asString(raw.position, `preflopActions[${index}].position`),
    kind: kind as PreflopActionKind,
  };
  if (raw.sizeBb !== undefined && raw.sizeBb !== null) {
    action.sizeBb = asNumber(raw.sizeBb, `preflopActions[${index}].sizeBb`);
  }
  return action;
}

function parsePreflopActions(raw: unknown): PreflopAction[] {
  if (!Array.isArray(raw)) {
    throw new Error("RangeProfile.preflopActions must be an array");
  }
  return raw.map((entry, index) => parsePreflopAction(entry, index));
}

/**
 * Validate and normalize unknown JSON into a RangeProfile.
 * Throws on missing/invalid required fields.
 * Does not upgrade synthetic_fixture or unknown classifications to stronger claims.
 */
export function parseRangeProfile(json: unknown): RangeProfile {
  if (!isRecord(json)) {
    throw new Error("RangeProfile must be a JSON object");
  }

  const schemaVersion = asNumber(json.schemaVersion, "schemaVersion");
  if (schemaVersion < 1 || !Number.isInteger(schemaVersion)) {
    throw new Error("RangeProfile.schemaVersion must be an integer >= 1");
  }

  const provenance = parseProvenance(json.provenance);
  const profile: RangeProfile = {
    schemaVersion,
    id: asString(json.id, "id"),
    dataRevision: asRevision(json.dataRevision),
    displayName: asString(json.displayName, "displayName"),
    format: asString(json.format, "format"),
    playerCount: asNumber(json.playerCount, "playerCount"),
    positions: parsePositions(json.positions),
    preflopActions: parsePreflopActions(json.preflopActions),
    startingStackBb: asNumber(json.startingStackBb, "startingStackBb"),
    blinds: parseBlinds(json.blinds),
    rake: parseRake(json.rake),
    ranges: parseRanges(json.ranges),
    provenance,
  };

  if (json.antes !== undefined && json.antes !== null) {
    profile.antes = asNumber(json.antes, "antes");
  }

  const labels = parseLabels(json.labels);
  if (labels) {
    profile.labels = labels;
  }

  if (json.legacyPreset !== undefined && json.legacyPreset !== null) {
    profile.legacyPreset = asBoolean(json.legacyPreset, "legacyPreset");
  }

  // Reject fabricated completeness: synthetic fixtures must keep that label.
  if (
    provenance.classification === "synthetic_fixture" &&
    profile.legacyPreset === true
  ) {
    // Allowed but unusual; leave as authored — still excluded from exact match via legacy.
  }

  return profile;
}

/** Non-throwing Result wrapper around {@link parseRangeProfile}. */
export function tryParseRangeProfile(json: unknown): ParseResult<RangeProfile> {
  try {
    return { ok: true, value: parseRangeProfile(json) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Parse a profile document from file/string contents (JSON text or already-parsed object). */
export function parseRangeProfileDocument(contents: string | unknown): RangeProfile {
  if (typeof contents === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch (error) {
      throw new Error(
        `Invalid range profile JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return parseRangeProfile(parsed);
  }
  return parseRangeProfile(contents);
}

export function tryParseRangeProfileDocument(
  contents: string | unknown,
): ParseResult<RangeProfile> {
  try {
    return { ok: true, value: parseRangeProfileDocument(contents) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Wrap a legacy flat preset `{id,name,text}` into a RangeProfile for catalogue display.
 * Assumptions are unknown; `legacyPreset: true` excludes it from exact-match claims.
 */
export function wrapLegacyPreset(input: LegacyPresetInput): RangeProfile {
  const seat = input.seat ?? "both";
  const empty = "";
  const ranges: ProfileRanges =
    seat === "oop"
      ? { oop: input.text, ip: empty }
      : seat === "ip"
        ? { oop: empty, ip: input.text }
        : { oop: input.text, ip: input.text };

  return {
    schemaVersion: RANGE_PROFILE_SCHEMA_VERSION,
    id: `legacy:${input.id}`,
    dataRevision: 1,
    displayName: input.name,
    format: "unknown",
    playerCount: 0,
    positions: { oop: "unknown", ip: "unknown" },
    preflopActions: [],
    // Placeholder zeros — not strategic claims; legacyPreset excludes exact match.
    startingStackBb: 0,
    blinds: { sb: 0, bb: 0 },
    rake: {
      rate: 0,
      cap: 0,
      collection: "unknown",
      known: false,
    },
    labels: { intendedUse: "legacy_flat_preset" },
    ranges,
    provenance: {
      source: `legacy-preset:${input.id}`,
      classification: "unknown",
      notes:
        "Wrapped flat configs/ranges preset. Assumptions (stack, open, format, rake, positions) unknown. Excluded from automatic exact-match claims.",
    },
    legacyPreset: true,
  };
}

/** Extract the first open size in bb from an action history, if any. */
export function openSizeFromActions(actions: PreflopAction[]): number | undefined {
  for (const action of actions) {
    if (action.kind === "open" && typeof action.sizeBb === "number") {
      return action.sizeBb;
    }
  }
  return undefined;
}
