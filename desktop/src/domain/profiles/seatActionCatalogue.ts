import type { SeatActionQuery, SeatActionRange } from "./seatActionTypes";
import { SEAT_ACTION_STORAGE_KEY } from "./seatActionTypes";

export interface SeatActionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface SeatActionCatalogue {
  list(): SeatActionRange[];
  get(id: string): SeatActionRange | undefined;
  find(query: SeatActionQuery): SeatActionRange[];
  importAtom(atom: SeatActionRange): void;
  clearUserImports(): void;
}

function norm(pos: string | undefined): string | undefined {
  if (!pos) return undefined;
  const p = pos.trim().toUpperCase();
  return p === "BU" ? "BTN" : p;
}

function readUser(storage?: SeatActionStorage): SeatActionRange[] {
  if (!storage) return [];
  const raw = storage.getItem(SEAT_ACTION_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is SeatActionRange =>
        Boolean(entry && typeof entry === "object" && typeof (entry as SeatActionRange).id === "string"),
    );
  } catch {
    return [];
  }
}

function writeUser(storage: SeatActionStorage | undefined, atoms: SeatActionRange[]): void {
  if (!storage) return;
  storage.setItem(SEAT_ACTION_STORAGE_KEY, JSON.stringify(atoms));
}

export function createSeatActionCatalogue(
  seed: readonly SeatActionRange[] = [],
  storage?: SeatActionStorage,
): SeatActionCatalogue {
  const bundled = new Map<string, SeatActionRange>();
  const user = new Map<string, SeatActionRange>();
  for (const atom of seed) {
    bundled.set(atom.id, atom);
  }
  for (const atom of readUser(storage)) {
    user.set(atom.id, atom);
  }

  function all(): SeatActionRange[] {
    const map = new Map<string, SeatActionRange>();
    for (const atom of bundled.values()) map.set(atom.id, atom);
    for (const atom of user.values()) map.set(atom.id, atom);
    return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  return {
    list: () => all(),
    get(id: string) {
      return user.get(id) ?? bundled.get(id);
    },
    find(query: SeatActionQuery) {
      const hero = norm(query.heroPosition);
      const vill = norm(query.villainPosition);
      return all().filter((atom) => {
        if (hero && norm(atom.heroPosition) !== hero) return false;
        if (vill && atom.villainPosition && norm(atom.villainPosition) !== vill) {
          return false;
        }
        if (query.action && atom.action !== query.action) return false;
        if (query.vsAction && atom.vsAction !== query.vsAction) return false;
        if (
          query.stakesLabel &&
          atom.labels?.stakes &&
          atom.labels.stakes.toUpperCase() !== query.stakesLabel.toUpperCase()
        ) {
          return false;
        }
        if (
          query.stackBb !== undefined &&
          atom.startingStackBb !== undefined &&
          atom.startingStackBb !== query.stackBb
        ) {
          return false;
        }
        return true;
      });
    },
    importAtom(atom: SeatActionRange) {
      user.set(atom.id, atom);
      writeUser(storage, [...user.values()]);
    },
    clearUserImports() {
      user.clear();
      writeUser(storage, []);
    },
  };
}

let singleton: SeatActionCatalogue | null = null;

export function getSeatActionCatalogue(
  seedLoader: () => SeatActionRange[],
): SeatActionCatalogue {
  if (!singleton) {
    const storage =
      typeof localStorage !== "undefined" ? localStorage : undefined;
    singleton = createSeatActionCatalogue(seedLoader(), storage);
  }
  return singleton;
}

export function resetSeatActionCatalogueForTests(): void {
  singleton = null;
}
