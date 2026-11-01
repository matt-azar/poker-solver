import { parseRangeProfile, tryParseRangeProfileDocument, wrapLegacyPreset } from "./parse";
import {
  RANGE_PROFILES_STORAGE_KEY,
  type AppliedProfileSnapshot,
  type LegacyPresetInput,
  type RangeProfile,
} from "./types";

/** Minimal storage surface so Node tests can inject a Map-backed stub. */
export interface ProfileStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface ImportProfileResult {
  profile?: RangeProfile;
  error?: string;
}

export interface RangeProfileCatalogue {
  listProfiles(): RangeProfile[];
  getProfile(id: string): RangeProfile | undefined;
  /** Reopen must request a specific revision; never silently upgrade. */
  getProfileRevision(id: string, revision: string | number): RangeProfile | undefined;
  importProfile(raw: unknown): ImportProfileResult;
  addProfiles(profiles: readonly RangeProfile[]): void;
  addLegacyPresets(presets: readonly LegacyPresetInput[]): void;
  /** Snapshot ranges + id/revision for study persistence. */
  snapshotForApply(profile: RangeProfile): AppliedProfileSnapshot;
  /** True when the latest revision for `id` came from a user import. */
  isUserImport(id: string): boolean;
  /** Remove one user-imported id (all revisions). Bundled seed is untouched. */
  removeUserImport(id: string): boolean;
  /** Clear user-imported entries from injectable storage (bundled seed remains). */
  clearUserImports(): void;
}

function revisionKey(revision: string | number): string {
  return String(revision);
}

function readUserImports(storage: ProfileStorage | undefined): RangeProfile[] {
  if (!storage) {
    return [];
  }
  const raw = storage.getItem(RANGE_PROFILES_STORAGE_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const profiles: RangeProfile[] = [];
    for (const entry of parsed) {
      try {
        profiles.push(parseRangeProfile(entry));
      } catch {
        // Skip corrupt entries rather than wiping the whole store.
      }
    }
    return profiles;
  } catch {
    return [];
  }
}

function writeUserImports(storage: ProfileStorage | undefined, profiles: RangeProfile[]): void {
  if (!storage) {
    return;
  }
  storage.setItem(RANGE_PROFILES_STORAGE_KEY, JSON.stringify(profiles));
}

/**
 * In-memory catalogue of bundled + user-imported range profiles.
 * User imports persist under `holdem-study-range-profiles` via injectable storage.
 */
export function createRangeProfileCatalogue(
  seed: readonly RangeProfile[] = [],
  storage?: ProfileStorage,
): RangeProfileCatalogue {
  /** Bundled / seed profiles (not written to localStorage). */
  const bundled = new Map<string, Map<string, RangeProfile>>();
  /** User-imported profiles (persisted). */
  const userImports = new Map<string, Map<string, RangeProfile>>();

  function put(
    store: Map<string, Map<string, RangeProfile>>,
    profile: RangeProfile,
  ): void {
    let revisions = store.get(profile.id);
    if (!revisions) {
      revisions = new Map();
      store.set(profile.id, revisions);
    }
    revisions.set(revisionKey(profile.dataRevision), profile);
  }

  for (const profile of seed) {
    put(bundled, profile);
  }
  for (const profile of readUserImports(storage)) {
    put(userImports, profile);
  }

  function allRevisions(): RangeProfile[] {
    const out: RangeProfile[] = [];
    for (const revisions of bundled.values()) {
      for (const profile of revisions.values()) {
        out.push(profile);
      }
    }
    for (const revisions of userImports.values()) {
      for (const profile of revisions.values()) {
        out.push(profile);
      }
    }
    return out;
  }

  /** Prefer the highest lexicographic/numeric revision string for list/get by id. */
  function latestForId(id: string): RangeProfile | undefined {
    const fromUser = userImports.get(id);
    const fromBundled = bundled.get(id);
    const candidates: RangeProfile[] = [];
    if (fromUser) {
      candidates.push(...fromUser.values());
    }
    if (fromBundled) {
      candidates.push(...fromBundled.values());
    }
    if (candidates.length === 0) {
      return undefined;
    }
    return candidates.reduce((best, next) =>
      revisionKey(next.dataRevision) >= revisionKey(best.dataRevision) ? next : best,
    );
  }

  function persistUsers(): void {
    const profiles: RangeProfile[] = [];
    for (const revisions of userImports.values()) {
      for (const profile of revisions.values()) {
        profiles.push(profile);
      }
    }
    writeUserImports(storage, profiles);
  }

  return {
    listProfiles() {
      const seen = new Set<string>();
      const list: RangeProfile[] = [];
      // Latest revision per id for catalogue display.
      for (const profile of allRevisions()) {
        if (seen.has(profile.id)) {
          continue;
        }
        const latest = latestForId(profile.id);
        if (latest) {
          seen.add(latest.id);
          list.push(latest);
        }
      }
      return list;
    },

    getProfile(id: string) {
      return latestForId(id);
    },

    getProfileRevision(id: string, revision: string | number) {
      const key = revisionKey(revision);
      const userHit = userImports.get(id)?.get(key);
      if (userHit) {
        return userHit;
      }
      return bundled.get(id)?.get(key);
    },

    importProfile(raw: unknown): ImportProfileResult {
      const result = tryParseRangeProfileDocument(raw);
      if (!result.ok) {
        return { error: result.error };
      }
      put(userImports, result.value);
      persistUsers();
      return { profile: result.value };
    },

    addProfiles(profiles: readonly RangeProfile[]) {
      for (const profile of profiles) {
        put(bundled, parseRangeProfile(profile));
      }
    },

    addLegacyPresets(presets: readonly LegacyPresetInput[]) {
      for (const preset of presets) {
        put(bundled, wrapLegacyPreset(preset));
      }
    },

    snapshotForApply(profile: RangeProfile): AppliedProfileSnapshot {
      return {
        profileId: profile.id,
        dataRevision: profile.dataRevision,
        ranges: {
          oop: profile.ranges.oop,
          ip: profile.ranges.ip,
        },
      };
    },

    isUserImport(id: string) {
      return userImports.has(id);
    },

    removeUserImport(id: string) {
      if (!userImports.has(id)) {
        return false;
      }
      userImports.delete(id);
      persistUsers();
      return true;
    },

    clearUserImports() {
      userImports.clear();
      persistUsers();
    },
  };
}

/** Apply a stored snapshot into study range fields without consulting a live catalogue. */
export function rangesFromSnapshot(snapshot: AppliedProfileSnapshot): {
  oopRange: string;
  ipRange: string;
  profileId: string;
  dataRevision: string | number;
} {
  return {
    oopRange: snapshot.ranges.oop,
    ipRange: snapshot.ranges.ip,
    profileId: snapshot.profileId,
    dataRevision: snapshot.dataRevision,
  };
}
