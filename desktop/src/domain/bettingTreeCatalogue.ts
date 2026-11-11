/**
 * Flat localStorage catalogue of named betting trees (no folders).
 * Mirrors the range-catalogue persistence pattern at one level.
 *
 * Entry ids are opaque and stable across renames. Display names may collide
 * only when the caller passes an explicit replaceId.
 */
import {
  BETTING_TREE_FORMAT,
  BETTING_TREE_VERSION,
  type BettingTreeDocument,
  type BettingTreeDraftPatch,
  parseBettingTree,
  serializeBettingTree,
} from "./bettingTreeFile";

export const BETTING_TREE_CATALOGUE_STORAGE_KEY = "holdem-study-betting-trees";

export interface BettingTreeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface SavedBettingTree {
  id: string;
  displayName: string;
  /** Opaque revision for overwrite tracking. */
  dataRevision: string;
  document: BettingTreeDocument;
}

export type CatalogueMutationResult =
  | { ok: true; entry: SavedBettingTree }
  | {
      ok: false;
      error: string;
      reason: "blank_name" | "not_found" | "name_collision" | "storage";
      collidingId?: string;
    };

export type CatalogueRemoveResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      reason: "not_found" | "storage";
    };

export interface BettingTreeCatalogue {
  list(): SavedBettingTree[];
  get(id: string): SavedBettingTree | undefined;
  /**
   * Insert a new opaque id, or replace an existing entry when replaceId is set.
   * Same-name collision without replaceId returns name_collision (no mutation).
   */
  save(
    displayName: string,
    document: BettingTreeDocument,
    opts?: { replaceId?: string },
  ): CatalogueMutationResult;
  rename(
    id: string,
    displayName: string,
    opts?: { replaceId?: string },
  ): CatalogueMutationResult;
  remove(id: string): CatalogueRemoveResult;
  clear(): CatalogueRemoveResult;
}

/** Legacy slug id used before opaque ids — kept for migration detection. */
export function savedBettingTreeId(displayName: string): string {
  const slug =
    displayName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "tree";
  return `user-saved-tree-${slug}`;
}

function normalizeNameKey(displayName: string): string {
  return displayName.trim().toLowerCase();
}

function newBettingTreeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `user-saved-tree-${crypto.randomUUID()}`;
  }
  return `user-saved-tree-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function isLegacySlugId(id: string, displayName: string): boolean {
  return id === savedBettingTreeId(displayName);
}

function readEntries(storage?: BettingTreeStorage): {
  entries: SavedBettingTree[];
  migrated: boolean;
} {
  if (!storage) {
    return { entries: [], migrated: false };
  }
  const raw = storage.getItem(BETTING_TREE_CATALOGUE_STORAGE_KEY);
  if (!raw) {
    return { entries: [], migrated: false };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return { entries: [], migrated: false };
    }
    const out: SavedBettingTree[] = [];
    let migrated = false;
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const obj = entry as Record<string, unknown>;
      if (typeof obj.id !== "string" || typeof obj.displayName !== "string") {
        continue;
      }
      const serialized =
        typeof obj.document === "string"
          ? obj.document
          : obj.document && typeof obj.document === "object"
            ? serializeBettingTree(obj.document as BettingTreeDocument)
            : null;
      if (!serialized) {
        continue;
      }
      const parsedDoc = parseBettingTree(serialized);
      if (!parsedDoc.ok) {
        continue;
      }
      const displayName = obj.displayName.trim() || "Saved tree";
      let id = obj.id;
      if (isLegacySlugId(id, displayName)) {
        id = newBettingTreeId();
        migrated = true;
      }
      out.push({
        id,
        displayName,
        dataRevision:
          typeof obj.dataRevision === "string"
            ? obj.dataRevision
            : Date.now().toString(36),
        document: {
          ...parsedDoc.document,
          name: displayName || parsedDoc.document.name,
        },
      });
    }
    return { entries: out, migrated };
  } catch {
    return { entries: [], migrated: false };
  }
}

function writeEntries(storage: BettingTreeStorage | undefined, entries: SavedBettingTree[]): void {
  if (!storage) {
    return;
  }
  storage.setItem(BETTING_TREE_CATALOGUE_STORAGE_KEY, JSON.stringify(entries));
}

function normalizeDocument(
  displayName: string,
  document: BettingTreeDocument,
): BettingTreeDocument {
  return {
    format: BETTING_TREE_FORMAT,
    version: BETTING_TREE_VERSION,
    name: displayName,
    tree: document.tree as BettingTreeDraftPatch,
  };
}

function findNameCollision(
  entries: Map<string, SavedBettingTree>,
  displayName: string,
  exceptId?: string,
): SavedBettingTree | undefined {
  const key = normalizeNameKey(displayName);
  for (const entry of entries.values()) {
    if (exceptId && entry.id === exceptId) {
      continue;
    }
    if (normalizeNameKey(entry.displayName) === key) {
      return entry;
    }
  }
  return undefined;
}

export function createBettingTreeCatalogue(
  storage?: BettingTreeStorage,
): BettingTreeCatalogue {
  const entries = new Map<string, SavedBettingTree>();
  const loaded = readEntries(storage);
  for (const entry of loaded.entries) {
    entries.set(entry.id, entry);
  }
  if (loaded.migrated) {
    // Persist rewritten opaque ids before exposing live state to callers.
    writeEntries(storage, [...entries.values()]);
  }

  function commit(next: Map<string, SavedBettingTree>): CatalogueMutationResult | true {
    try {
      writeEntries(storage, [...next.values()]);
    } catch (error) {
      return {
        ok: false,
        reason: "storage",
        error: error instanceof Error ? error.message : "Storage write failed",
      };
    }
    entries.clear();
    for (const [key, value] of next) {
      entries.set(key, value);
    }
    return true;
  }

  return {
    list() {
      return [...entries.values()].sort((a, b) =>
        a.displayName.localeCompare(b.displayName),
      );
    },
    get(id: string) {
      return entries.get(id);
    },
    save(displayName, document, opts) {
      const name = displayName.trim();
      if (!name) {
        return {
          ok: false,
          reason: "blank_name",
          error: "Enter a name for the saved tree.",
        };
      }
      const next = new Map(entries);
      const replaceId = opts?.replaceId;
      if (replaceId) {
        if (!next.has(replaceId)) {
          return {
            ok: false,
            reason: "not_found",
            error: "Could not find that saved tree.",
          };
        }
        const collision = findNameCollision(next, name, replaceId);
        if (collision) {
          return {
            ok: false,
            reason: "name_collision",
            error: `A tree named "${collision.displayName}" already exists.`,
            collidingId: collision.id,
          };
        }
        const saved: SavedBettingTree = {
          id: replaceId,
          displayName: name,
          dataRevision: Date.now().toString(36),
          document: normalizeDocument(name, document),
        };
        next.set(replaceId, saved);
        const committed = commit(next);
        if (committed !== true) {
          return committed;
        }
        return { ok: true, entry: saved };
      }

      const collision = findNameCollision(next, name);
      if (collision) {
        return {
          ok: false,
          reason: "name_collision",
          error: `A tree named "${collision.displayName}" already exists.`,
          collidingId: collision.id,
        };
      }
      const saved: SavedBettingTree = {
        id: newBettingTreeId(),
        displayName: name,
        dataRevision: Date.now().toString(36),
        document: normalizeDocument(name, document),
      };
      next.set(saved.id, saved);
      const committed = commit(next);
      if (committed !== true) {
        return committed;
      }
      return { ok: true, entry: saved };
    },
    rename(id, displayName, opts) {
      const existing = entries.get(id);
      if (!existing) {
        return {
          ok: false,
          reason: "not_found",
          error: "Could not find that saved tree.",
        };
      }
      const name = displayName.trim();
      if (!name) {
        return {
          ok: false,
          reason: "blank_name",
          error: "Saved tree name cannot be empty.",
        };
      }
      const next = new Map(entries);
      const collision = findNameCollision(next, name, id);
      if (collision) {
        if (!opts?.replaceId || opts.replaceId !== collision.id) {
          return {
            ok: false,
            reason: "name_collision",
            error: `A tree named "${collision.displayName}" already exists.`,
            collidingId: collision.id,
          };
        }
        next.delete(collision.id);
      }
      const saved: SavedBettingTree = {
        id,
        displayName: name,
        dataRevision: Date.now().toString(36),
        document: normalizeDocument(name, existing.document),
      };
      next.set(id, saved);
      const committed = commit(next);
      if (committed !== true) {
        return committed;
      }
      return { ok: true, entry: saved };
    },
    remove(id) {
      if (!entries.has(id)) {
        return {
          ok: false,
          reason: "not_found",
          error: "Could not find that saved tree.",
        };
      }
      const next = new Map(entries);
      next.delete(id);
      try {
        writeEntries(storage, [...next.values()]);
      } catch (error) {
        return {
          ok: false,
          reason: "storage",
          error: error instanceof Error ? error.message : "Storage write failed",
        };
      }
      entries.clear();
      for (const [key, value] of next) {
        entries.set(key, value);
      }
      return { ok: true };
    },
    clear() {
      try {
        writeEntries(storage, []);
      } catch (error) {
        return {
          ok: false,
          reason: "storage",
          error: error instanceof Error ? error.message : "Storage write failed",
        };
      }
      entries.clear();
      return { ok: true };
    },
  };
}

let singleton: BettingTreeCatalogue | null = null;

function browserStorage(): BettingTreeStorage | undefined {
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Shared flat betting-tree catalogue (localStorage). */
export function getBettingTreeCatalogue(): BettingTreeCatalogue {
  if (!singleton) {
    singleton = createBettingTreeCatalogue(browserStorage());
  }
  return singleton;
}

/** Test helper — reset singleton between cases. */
export function resetBettingTreeCatalogueForTests(
  storage?: BettingTreeStorage,
): BettingTreeCatalogue {
  singleton = createBettingTreeCatalogue(storage);
  return singleton;
}
