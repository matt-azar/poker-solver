/**
 * In-app solutions catalogue (localStorage index + managed .psol paths).
 * Folders use `/` separators (multi-level). Primary Save/Open UX — no OS picker.
 *
 * Entry ids are opaque and stable across renames. Display-name collisions are
 * scoped per folder; replaceId overwrites an existing entry.
 */
export const SOLUTIONS_CATALOGUE_STORAGE_KEY = "holdem-study-solutions";

export const UNFILED_FOLDER = "";

export interface SolutionsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface SavedSolution {
  id: string;
  displayName: string;
  /** Folder path with `/` separators; empty string = Unfiled. */
  folder: string;
  /** Absolute (or managed) filesystem path for engine save/open. */
  path: string;
  dataRevision: string;
}

export interface SolutionsCatalogueData {
  folders: string[];
  entries: SavedSolution[];
}

export type CatalogueMutationResult =
  | { ok: true; entry: SavedSolution }
  | {
      ok: false;
      error: string;
      reason: "blank_name" | "not_found" | "name_collision" | "storage" | "invalid_folder";
      collidingId?: string;
    };

export type CatalogueFolderResult =
  | { ok: true; folder: string }
  | {
      ok: false;
      error: string;
      reason: "blank_name" | "exists" | "not_found" | "not_empty" | "storage" | "invalid_folder";
    };

export type CatalogueRemoveResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      reason: "not_found" | "storage";
    };

export interface SolutionsCatalogue {
  list(): SavedSolution[];
  listFolders(): string[];
  get(id: string): SavedSolution | undefined;
  findByPath(path: string): SavedSolution | undefined;
  save(
    displayName: string,
    path: string,
    opts?: { folder?: string; replaceId?: string },
  ): CatalogueMutationResult;
  rename(id: string, displayName: string): CatalogueMutationResult;
  move(id: string, folder: string): CatalogueMutationResult;
  remove(id: string): CatalogueRemoveResult;
  addFolder(folder: string): CatalogueFolderResult;
  renameFolder(folder: string, nextFolder: string): CatalogueFolderResult;
  removeFolder(folder: string): CatalogueFolderResult;
  clear(): CatalogueRemoveResult;
}

/** Unsafe path/name characters rejected in folder segments and file stems. */
const UNSAFE = /[<>:"|?*\\]|[\u0000-\u001f]/g;

export function sanitizeSegment(raw: string): string {
  return raw
    .trim()
    .replace(UNSAFE, "")
    .replace(/\s+/g, " ")
    .replace(/\.+$/g, "")
    .trim();
}

export function normalizeFolderPath(folder: string | undefined | null): string {
  if (!folder) {
    return UNFILED_FOLDER;
  }
  const parts = folder
    .split(/[/\\]+/)
    .map((part) => sanitizeSegment(part))
    .filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) {
    return UNFILED_FOLDER;
  }
  return parts.join("/");
}

export function isValidFolderPath(folder: string): boolean {
  if (folder === UNFILED_FOLDER) {
    return true;
  }
  return normalizeFolderPath(folder) === folder && folder.length > 0;
}

export function fileStemFromDisplayName(displayName: string): string {
  const cleaned = sanitizeSegment(displayName) || "solution";
  return cleaned.replace(/\.psol$/i, "") || "solution";
}

/**
 * Relative key under the solutions root, e.g. `SRP/100bb/spot.psol`.
 * Unfiled → `spot.psol`.
 */
export function relativeSolutionKey(folder: string, displayName: string): string {
  const stem = fileStemFromDisplayName(displayName);
  const normalized = normalizeFolderPath(folder);
  const file = `${stem}.psol`;
  return normalized ? `${normalized}/${file}` : file;
}

/** Join solutions root + relative key with `/` (engine accepts either separator). */
export function joinSolutionsPath(root: string, relativeKey: string): string {
  const base = root.replace(/[/\\]+$/g, "");
  const rel = relativeKey.replace(/^[/\\]+/g, "").replace(/\\/g, "/");
  if (!base) {
    return rel;
  }
  return `${base}/${rel}`;
}

function normalizeNameKey(displayName: string): string {
  return displayName.trim().toLowerCase();
}

function newSolutionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `user-saved-solution-${crypto.randomUUID()}`;
  }
  return `user-saved-solution-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function emptyData(): SolutionsCatalogueData {
  return { folders: [], entries: [] };
}

function readData(storage?: SolutionsStorage): SolutionsCatalogueData {
  if (!storage) {
    return emptyData();
  }
  const raw = storage.getItem(SOLUTIONS_CATALOGUE_STORAGE_KEY);
  if (!raw) {
    return emptyData();
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return emptyData();
    }
    const obj = parsed as Record<string, unknown>;
    const foldersRaw = Array.isArray(obj.folders) ? obj.folders : [];
    const folders = [
      ...new Set(
        foldersRaw
          .filter((entry): entry is string => typeof entry === "string")
          .map((folder) => normalizeFolderPath(folder))
          .filter((folder) => folder !== UNFILED_FOLDER),
      ),
    ].sort((a, b) => a.localeCompare(b));

    const entriesRaw = Array.isArray(obj.entries)
      ? obj.entries
      : Array.isArray(parsed)
        ? parsed
        : [];
    const entries: SavedSolution[] = [];
    for (const entry of entriesRaw) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const item = entry as Record<string, unknown>;
      if (
        typeof item.id !== "string" ||
        typeof item.displayName !== "string" ||
        typeof item.path !== "string"
      ) {
        continue;
      }
      const displayName = item.displayName.trim() || "Saved solution";
      const folder = normalizeFolderPath(
        typeof item.folder === "string" ? item.folder : UNFILED_FOLDER,
      );
      entries.push({
        id: item.id,
        displayName,
        folder,
        path: item.path.trim(),
        dataRevision:
          typeof item.dataRevision === "string"
            ? item.dataRevision
            : Date.now().toString(36),
      });
    }
    return { folders, entries };
  } catch {
    return emptyData();
  }
}

function writeData(storage: SolutionsStorage | undefined, data: SolutionsCatalogueData): void {
  if (!storage) {
    return;
  }
  storage.setItem(SOLUTIONS_CATALOGUE_STORAGE_KEY, JSON.stringify(data));
}

function findNameCollision(
  entries: SavedSolution[],
  folder: string,
  displayName: string,
  exceptId?: string,
): SavedSolution | undefined {
  const key = normalizeNameKey(displayName);
  const folderKey = normalizeFolderPath(folder);
  for (const entry of entries) {
    if (exceptId && entry.id === exceptId) {
      continue;
    }
    if (
      normalizeFolderPath(entry.folder) === folderKey &&
      normalizeNameKey(entry.displayName) === key
    ) {
      return entry;
    }
  }
  return undefined;
}

function collectFolders(
  folders: string[],
  entries: SavedSolution[],
): string[] {
  const set = new Set<string>();
  for (const folder of folders) {
    const normalized = normalizeFolderPath(folder);
    if (normalized) {
      set.add(normalized);
      // Ensure parent prefixes exist as listed folders.
      const parts = normalized.split("/");
      for (let i = 1; i < parts.length; i += 1) {
        set.add(parts.slice(0, i).join("/"));
      }
    }
  }
  for (const entry of entries) {
    const normalized = normalizeFolderPath(entry.folder);
    if (normalized) {
      set.add(normalized);
      const parts = normalized.split("/");
      for (let i = 1; i < parts.length; i += 1) {
        set.add(parts.slice(0, i).join("/"));
      }
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

export type SolutionsTreeNode =
  | {
      kind: "folder";
      id: string;
      name: string;
      folder: string;
      children: SolutionsTreeNode[];
    }
  | {
      kind: "file";
      id: string;
      entry: SavedSolution;
    };

/** Build a nested tree for catalogue UI (Unfiled as a synthetic root folder). */
export function buildSolutionsTree(
  folders: string[],
  entries: SavedSolution[],
): SolutionsTreeNode[] {
  type MutableFolder = {
    kind: "folder";
    id: string;
    name: string;
    folder: string;
    children: SolutionsTreeNode[];
    folderMap: Map<string, MutableFolder>;
  };

  const rootChildren: SolutionsTreeNode[] = [];
  const rootFolders = new Map<string, MutableFolder>();

  const ensureFolder = (folderPath: string): MutableFolder | null => {
    const normalized = normalizeFolderPath(folderPath);
    if (!normalized) {
      return null;
    }
    const parts = normalized.split("/");
    let map = rootFolders;
    let parentList: SolutionsTreeNode[] = rootChildren;
    let current: MutableFolder | null = null;
    let path = "";
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      let next = map.get(part);
      if (!next) {
        next = {
          kind: "folder",
          id: `folder:${path}`,
          name: part,
          folder: path,
          children: [],
          folderMap: new Map(),
        };
        map.set(part, next);
        parentList.push(next);
      }
      current = next;
      map = next.folderMap;
      parentList = next.children;
    }
    return current;
  };

  for (const folder of collectFolders(folders, entries)) {
    ensureFolder(folder);
  }

  const unfiled: SolutionsTreeNode[] = [];
  for (const entry of [...entries].sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  )) {
    const fileNode: SolutionsTreeNode = {
      kind: "file",
      id: entry.id,
      entry,
    };
    const folder = normalizeFolderPath(entry.folder);
    if (!folder) {
      unfiled.push(fileNode);
      continue;
    }
    const parent = ensureFolder(folder);
    if (parent) {
      parent.children.push(fileNode);
    } else {
      unfiled.push(fileNode);
    }
  }

  const sortNodes = (nodes: SolutionsTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === "folder" ? -1 : 1;
      }
      const an = a.kind === "folder" ? a.name : a.entry.displayName;
      const bn = b.kind === "folder" ? b.name : b.entry.displayName;
      return an.localeCompare(bn);
    });
    for (const node of nodes) {
      if (node.kind === "folder") {
        sortNodes(node.children);
      }
    }
  };

  sortNodes(rootChildren);

  const out: SolutionsTreeNode[] = [...rootChildren];
  if (unfiled.length > 0 || folders.length === 0) {
    out.push({
      kind: "folder",
      id: "folder:",
      name: "Unfiled",
      folder: UNFILED_FOLDER,
      children: unfiled,
    });
  }
  return out;
}

export function createSolutionsCatalogue(
  storage?: SolutionsStorage,
): SolutionsCatalogue {
  let data = readData(storage);
  data = {
    folders: collectFolders(data.folders, data.entries),
    entries: data.entries,
  };

  function commit(
    next: SolutionsCatalogueData,
  ): { ok: true } | { ok: false; error: string } {
    const normalized: SolutionsCatalogueData = {
      folders: collectFolders(next.folders, next.entries),
      entries: next.entries,
    };
    try {
      writeData(storage, normalized);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Storage write failed",
      };
    }
    data = normalized;
    return { ok: true };
  }

  return {
    list() {
      return [...data.entries].sort((a, b) => {
        const folderCmp = a.folder.localeCompare(b.folder);
        if (folderCmp !== 0) {
          return folderCmp;
        }
        return a.displayName.localeCompare(b.displayName);
      });
    },
    listFolders() {
      return collectFolders(data.folders, data.entries);
    },
    get(id) {
      return data.entries.find((entry) => entry.id === id);
    },
    findByPath(path) {
      const key = path.trim();
      if (!key) {
        return undefined;
      }
      return data.entries.find((entry) => entry.path === key);
    },
    save(displayName, path, opts) {
      const name = displayName.trim();
      if (!name) {
        return {
          ok: false,
          reason: "blank_name",
          error: "Enter a name for the saved solution.",
        };
      }
      const folder = normalizeFolderPath(opts?.folder);
      if (opts?.folder && !isValidFolderPath(folder) && folder !== UNFILED_FOLDER) {
        return {
          ok: false,
          reason: "invalid_folder",
          error: "Folder path is invalid.",
        };
      }
      const targetPath = path.trim();
      if (!targetPath) {
        return {
          ok: false,
          reason: "blank_name",
          error: "Solution path is required.",
        };
      }
      const replaceId = opts?.replaceId;
      const nextEntries = [...data.entries];
      if (replaceId) {
        const index = nextEntries.findIndex((entry) => entry.id === replaceId);
        if (index < 0) {
          return {
            ok: false,
            reason: "not_found",
            error: "Could not find that saved solution.",
          };
        }
        const collision = findNameCollision(nextEntries, folder, name, replaceId);
        if (collision) {
          return {
            ok: false,
            reason: "name_collision",
            error: `A solution named "${collision.displayName}" already exists in this folder.`,
            collidingId: collision.id,
          };
        }
        const saved: SavedSolution = {
          id: replaceId,
          displayName: name,
          folder,
          path: targetPath,
          dataRevision: Date.now().toString(36),
        };
        nextEntries[index] = saved;
        const committed = commit({ folders: data.folders, entries: nextEntries });
        if (!committed.ok) {
          return { ok: false, reason: "storage", error: committed.error };
        }
        return { ok: true, entry: saved };
      }

      const collision = findNameCollision(nextEntries, folder, name);
      if (collision) {
        return {
          ok: false,
          reason: "name_collision",
          error: `A solution named "${collision.displayName}" already exists in this folder.`,
          collidingId: collision.id,
        };
      }
      const saved: SavedSolution = {
        id: newSolutionId(),
        displayName: name,
        folder,
        path: targetPath,
        dataRevision: Date.now().toString(36),
      };
      nextEntries.push(saved);
      const committed = commit({ folders: data.folders, entries: nextEntries });
      if (!committed.ok) {
        return { ok: false, reason: "storage", error: committed.error };
      }
      return { ok: true, entry: saved };
    },
    rename(id, displayName) {
      const existing = data.entries.find((entry) => entry.id === id);
      if (!existing) {
        return {
          ok: false,
          reason: "not_found",
          error: "Could not find that saved solution.",
        };
      }
      const name = displayName.trim();
      if (!name) {
        return {
          ok: false,
          reason: "blank_name",
          error: "Saved solution name cannot be empty.",
        };
      }
      const collision = findNameCollision(data.entries, existing.folder, name, id);
      if (collision) {
        return {
          ok: false,
          reason: "name_collision",
          error: `A solution named "${collision.displayName}" already exists in this folder.`,
          collidingId: collision.id,
        };
      }
      const saved: SavedSolution = {
        ...existing,
        displayName: name,
        dataRevision: Date.now().toString(36),
      };
      const nextEntries = data.entries.map((entry) =>
        entry.id === id ? saved : entry,
      );
      const committed = commit({ folders: data.folders, entries: nextEntries });
      if (!committed.ok) {
        return { ok: false, reason: "storage", error: committed.error };
      }
      return { ok: true, entry: saved };
    },
    move(id, folder) {
      const existing = data.entries.find((entry) => entry.id === id);
      if (!existing) {
        return {
          ok: false,
          reason: "not_found",
          error: "Could not find that saved solution.",
        };
      }
      const nextFolder = normalizeFolderPath(folder);
      if (nextFolder === existing.folder) {
        return { ok: true, entry: existing };
      }
      const collision = findNameCollision(
        data.entries,
        nextFolder,
        existing.displayName,
        id,
      );
      if (collision) {
        return {
          ok: false,
          reason: "name_collision",
          error: `A solution named "${collision.displayName}" already exists in this folder.`,
          collidingId: collision.id,
        };
      }
      const saved: SavedSolution = {
        ...existing,
        folder: nextFolder,
        dataRevision: Date.now().toString(36),
      };
      const nextEntries = data.entries.map((entry) =>
        entry.id === id ? saved : entry,
      );
      const nextFolders = nextFolder
        ? [...data.folders, nextFolder]
        : data.folders;
      const committed = commit({ folders: nextFolders, entries: nextEntries });
      if (!committed.ok) {
        return { ok: false, reason: "storage", error: committed.error };
      }
      return { ok: true, entry: saved };
    },
    remove(id) {
      if (!data.entries.some((entry) => entry.id === id)) {
        return {
          ok: false,
          reason: "not_found",
          error: "Could not find that saved solution.",
        };
      }
      const nextEntries = data.entries.filter((entry) => entry.id !== id);
      const committed = commit({ folders: data.folders, entries: nextEntries });
      if (!committed.ok) {
        return {
          ok: false,
          reason: "storage",
          error: committed.error,
        };
      }
      return { ok: true };
    },
    addFolder(folder) {
      const normalized = normalizeFolderPath(folder);
      if (!normalized) {
        return {
          ok: false,
          reason: "blank_name",
          error: "Enter a folder name.",
        };
      }
      if (!isValidFolderPath(normalized)) {
        return {
          ok: false,
          reason: "invalid_folder",
          error: "Folder path is invalid.",
        };
      }
      if (collectFolders(data.folders, data.entries).includes(normalized)) {
        return {
          ok: false,
          reason: "exists",
          error: `Folder "${normalized}" already exists.`,
        };
      }
      const committed = commit({
        folders: [...data.folders, normalized],
        entries: data.entries,
      });
      if (!committed.ok) {
        return {
          ok: false,
          reason: "storage",
          error: committed.error,
        };
      }
      return { ok: true, folder: normalized };
    },
    renameFolder(folder, nextFolder) {
      const from = normalizeFolderPath(folder);
      const to = normalizeFolderPath(nextFolder);
      if (!from) {
        return {
          ok: false,
          reason: "not_found",
          error: "Could not find that folder.",
        };
      }
      if (!to) {
        return {
          ok: false,
          reason: "blank_name",
          error: "Enter a folder name.",
        };
      }
      const known = collectFolders(data.folders, data.entries);
      if (!known.includes(from)) {
        return {
          ok: false,
          reason: "not_found",
          error: "Could not find that folder.",
        };
      }
      if (known.includes(to) && to !== from) {
        return {
          ok: false,
          reason: "exists",
          error: `Folder "${to}" already exists.`,
        };
      }
      const rewrite = (path: string): string => {
        if (path === from) {
          return to;
        }
        if (path.startsWith(`${from}/`)) {
          return `${to}${path.slice(from.length)}`;
        }
        return path;
      };
      const nextEntries = data.entries.map((entry) => ({
        ...entry,
        folder: rewrite(entry.folder),
        dataRevision: Date.now().toString(36),
      }));
      const nextFolders = [
        ...new Set(
          data.folders
            .map((item) => rewrite(item))
            .filter((item) => item !== UNFILED_FOLDER),
        ),
      ];
      const committed = commit({ folders: nextFolders, entries: nextEntries });
      if (!committed.ok) {
        return {
          ok: false,
          reason: "storage",
          error: committed.error,
        };
      }
      return { ok: true, folder: to };
    },
    removeFolder(folder) {
      const normalized = normalizeFolderPath(folder);
      if (!normalized) {
        return {
          ok: false,
          reason: "not_found",
          error: "Could not find that folder.",
        };
      }
      const known = collectFolders(data.folders, data.entries);
      if (!known.includes(normalized)) {
        return {
          ok: false,
          reason: "not_found",
          error: "Could not find that folder.",
        };
      }
      const occupied = data.entries.some(
        (entry) =>
          entry.folder === normalized ||
          entry.folder.startsWith(`${normalized}/`),
      );
      const hasChildFolder = known.some(
        (item) => item !== normalized && item.startsWith(`${normalized}/`),
      );
      if (occupied || hasChildFolder) {
        return {
          ok: false,
          reason: "not_empty",
          error: "Remove or move solutions in this folder first.",
        };
      }
      const nextFolders = data.folders.filter(
        (item) => normalizeFolderPath(item) !== normalized,
      );
      const committed = commit({ folders: nextFolders, entries: data.entries });
      if (!committed.ok) {
        return {
          ok: false,
          reason: "storage",
          error: committed.error,
        };
      }
      return { ok: true, folder: normalized };
    },
    clear() {
      const committed = commit(emptyData());
      if (!committed.ok) {
        return {
          ok: false,
          reason: "storage",
          error: committed.error,
        };
      }
      return { ok: true };
    },
  };
}

let singleton: SolutionsCatalogue | null = null;

function browserStorage(): SolutionsStorage | undefined {
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Shared solutions catalogue (localStorage index). */
export function getSolutionsCatalogue(): SolutionsCatalogue {
  if (!singleton) {
    singleton = createSolutionsCatalogue(browserStorage());
  }
  return singleton;
}

/** Test helper — reset singleton between cases. */
export function resetSolutionsCatalogueForTests(
  storage?: SolutionsStorage,
): SolutionsCatalogue {
  singleton = createSolutionsCatalogue(storage);
  return singleton;
}
