export const STUDY_SETUP_PREFS_KEY = "holdem-study-setup-prefs";

/**
 * Optional saved defaults for study setup. Stakes labels are not stored as
 * stack depths — `defaultStackBb` is independent of any NL / stake label.
 */
export interface StudySetupPreferences {
  defaultProfileId?: string;
  defaultStackBb?: number;
  defaultOpenSizeBb?: number;
  defaultTreeBets?: {
    oopBets?: string;
    ipBets?: string;
    oopFlop?: string;
    ipFlop?: string;
    oopTurn?: string;
    ipTurn?: string;
    oopRiver?: string;
    ipRiver?: string;
    oopDonk?: string;
  };
  defaultPotCap?: number;
  defaultMaxRaises?: number;
  defaultAllowAllIn?: boolean;
  defaultNoThreeBet?: boolean;
  defaultGeometric?: boolean;
}

export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export function emptyStudySetupPreferences(): StudySetupPreferences {
  return {};
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function normalizeStudySetupPreferences(
  raw: unknown,
): StudySetupPreferences {
  if (!raw || typeof raw !== "object") {
    return emptyStudySetupPreferences();
  }
  const source = raw as Record<string, unknown>;
  const prefs: StudySetupPreferences = {};
  if (typeof source.defaultProfileId === "string" && source.defaultProfileId) {
    prefs.defaultProfileId = source.defaultProfileId;
  }
  if (isFiniteNumber(source.defaultStackBb) && source.defaultStackBb > 0) {
    prefs.defaultStackBb = source.defaultStackBb;
  }
  if (isFiniteNumber(source.defaultOpenSizeBb) && source.defaultOpenSizeBb > 0) {
    prefs.defaultOpenSizeBb = source.defaultOpenSizeBb;
  }
  if (source.defaultTreeBets && typeof source.defaultTreeBets === "object") {
    const bets = source.defaultTreeBets as Record<string, unknown>;
    const tree: NonNullable<StudySetupPreferences["defaultTreeBets"]> = {};
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
      if (typeof bets[key] === "string") {
        tree[key] = bets[key];
      }
    }
    if (Object.keys(tree).length > 0) {
      prefs.defaultTreeBets = tree;
    }
  }
  if (isFiniteNumber(source.defaultPotCap)) {
    prefs.defaultPotCap = source.defaultPotCap;
  }
  if (isFiniteNumber(source.defaultMaxRaises)) {
    prefs.defaultMaxRaises = source.defaultMaxRaises;
  }
  if (typeof source.defaultAllowAllIn === "boolean") {
    prefs.defaultAllowAllIn = source.defaultAllowAllIn;
  }
  if (typeof source.defaultNoThreeBet === "boolean") {
    prefs.defaultNoThreeBet = source.defaultNoThreeBet;
  }
  if (typeof source.defaultGeometric === "boolean") {
    prefs.defaultGeometric = source.defaultGeometric;
  }
  return prefs;
}

export function loadStudySetupPreferences(
  storage: StorageAdapter,
  key = STUDY_SETUP_PREFS_KEY,
): StudySetupPreferences {
  try {
    const raw = storage.getItem(key);
    if (!raw) {
      return emptyStudySetupPreferences();
    }
    return normalizeStudySetupPreferences(JSON.parse(raw));
  } catch {
    return emptyStudySetupPreferences();
  }
}

export function saveStudySetupPreferences(
  prefs: StudySetupPreferences,
  storage: StorageAdapter,
  key = STUDY_SETUP_PREFS_KEY,
): void {
  storage.setItem(key, JSON.stringify(normalizeStudySetupPreferences(prefs)));
}

export function clearStudySetupPreferences(
  storage: StorageAdapter,
  key = STUDY_SETUP_PREFS_KEY,
): void {
  if (storage.removeItem) {
    storage.removeItem(key);
  } else {
    storage.setItem(key, "");
  }
}

/** Browser helper; tests should pass an explicit StorageAdapter. */
export function browserLocalStorageAdapter(): StorageAdapter | null {
  if (typeof localStorage === "undefined") {
    return null;
  }
  return localStorage;
}
