/**
 * Flat localStorage catalogue of named betting trees (no folders).
 * Mirrors the range-catalogue persistence pattern at one level.
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

export interface BettingTreeCatalogue {
  list(): SavedBettingTree[];
  get(id: string): SavedBettingTree | undefined;
  /** Upsert by name (same slug overwrites). */
  save(displayName: string, document: BettingTreeDocument): SavedBettingTree;
  rename(id: string, displayName: string): SavedBettingTree | null;
  remove(id: string): boolean;
  clear(): void;
}

/** Stable id for a Build-saved betting tree name (overwrites on re-save). */
export function savedBettingTreeId(displayName: string): string {
  const slug =
    displayName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "tree";
  return `user-saved-tree-${slug}`;
}

function readEntries(storage?: BettingTreeStorage): SavedBettingTree[] {
  if (!storage) {
    return [];
  }
  const raw = storage.getItem(BETTING_TREE_CATALOGUE_STORAGE_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const out: SavedBettingTree[] = [];
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
      out.push({
        id: obj.id,
        displayName: obj.displayName.trim() || "Saved tree",
        dataRevision:
          typeof obj.dataRevision === "string"
            ? obj.dataRevision
            : Date.now().toString(36),
        document: {
          ...parsedDoc.document,
          name: obj.displayName.trim() || parsedDoc.document.name,
        },
      });
    }
    return out;
  } catch {
    return [];
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

export function createBettingTreeCatalogue(
  storage?: BettingTreeStorage,
): BettingTreeCatalogue {
  const entries = new Map<string, SavedBettingTree>();
  for (const entry of readEntries(storage)) {
    entries.set(entry.id, entry);
  }

  function persist(): void {
    writeEntries(storage, [...entries.values()]);
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
    save(displayName: string, document: BettingTreeDocument) {
      const name = displayName.trim();
      if (!name) {
        throw new Error("Enter a name for the saved tree.");
      }
      const id = savedBettingTreeId(name);
      const saved: SavedBettingTree = {
        id,
        displayName: name,
        dataRevision: Date.now().toString(36),
        document: normalizeDocument(name, document),
      };
      entries.set(id, saved);
      persist();
      return saved;
    },
    rename(id: string, displayName: string) {
      const existing = entries.get(id);
      if (!existing) {
        return null;
      }
      const name = displayName.trim();
      if (!name) {
        return null;
      }
      const nextId = savedBettingTreeId(name);
      const saved: SavedBettingTree = {
        id: nextId,
        displayName: name,
        dataRevision: Date.now().toString(36),
        document: normalizeDocument(name, existing.document),
      };
      entries.delete(id);
      // Replacing another tree with the same slug overwrites it intentionally.
      entries.set(nextId, saved);
      persist();
      return saved;
    },
    remove(id: string) {
      if (!entries.has(id)) {
        return false;
      }
      entries.delete(id);
      persist();
      return true;
    },
    clear() {
      entries.clear();
      persist();
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
