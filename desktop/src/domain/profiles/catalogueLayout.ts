/** Persisted folder chrome for the seat×action catalogue (renames + empty dirs). */

export const CATALOGUE_LAYOUT_STORAGE_KEY = "holdem-study-seat-action-layout";

export interface CatalogueLayout {
  /** Branch id → display label (e.g. "HJ" → "Hijack"). */
  renames: Record<string, string>;
  /** Extra empty position folders the user created. */
  extraPositions: string[];
  /** Extra empty line folders under a position (position → ["vs CO open"]). */
  extraLines: Record<string, string[]>;
  /** Bundled atom ids hidden after a user replace/delete in that slot. */
  hiddenBundledIds: string[];
}

export const EMPTY_CATALOGUE_LAYOUT: CatalogueLayout = {
  renames: {},
  extraPositions: [],
  extraLines: {},
  hiddenBundledIds: [],
};

export interface CatalogueLayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string" && entry.trim()) {
      out[key] = entry;
    }
  }
  return out;
}

function asStringArrayRecord(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const list = asStringArray(entry)
      .map((item) => item.trim())
      .filter(Boolean);
    if (list.length) {
      out[key] = [...new Set(list)];
    }
  }
  return out;
}

export function parseCatalogueLayout(raw: string | null): CatalogueLayout {
  if (!raw) {
    return { ...EMPTY_CATALOGUE_LAYOUT, renames: {}, extraPositions: [], extraLines: {}, hiddenBundledIds: [] };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return parseCatalogueLayout(null);
    }
    const obj = parsed as Record<string, unknown>;
    return {
      renames: asStringRecord(obj.renames),
      extraPositions: [...new Set(asStringArray(obj.extraPositions).map((p) => p.toUpperCase()))],
      extraLines: asStringArrayRecord(obj.extraLines),
      hiddenBundledIds: [...new Set(asStringArray(obj.hiddenBundledIds))],
    };
  } catch {
    return parseCatalogueLayout(null);
  }
}

export function readCatalogueLayout(storage?: CatalogueLayoutStorage): CatalogueLayout {
  if (!storage) {
    return parseCatalogueLayout(null);
  }
  return parseCatalogueLayout(storage.getItem(CATALOGUE_LAYOUT_STORAGE_KEY));
}

export function writeCatalogueLayout(
  storage: CatalogueLayoutStorage | undefined,
  layout: CatalogueLayout,
): void {
  if (!storage) return;
  storage.setItem(CATALOGUE_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
}

export function renameCatalogueBranch(
  layout: CatalogueLayout,
  branchId: string,
  label: string,
): CatalogueLayout {
  const nextLabel = label.trim();
  const renames = { ...layout.renames };
  if (!nextLabel) {
    delete renames[branchId];
  } else {
    renames[branchId] = nextLabel;
  }
  return { ...layout, renames };
}

export function addCataloguePosition(
  layout: CatalogueLayout,
  position: string,
): CatalogueLayout {
  const pos = position.trim().toUpperCase();
  if (!pos || layout.extraPositions.includes(pos)) {
    return layout;
  }
  return {
    ...layout,
    extraPositions: [...layout.extraPositions, pos],
  };
}

export function addCatalogueLine(
  layout: CatalogueLayout,
  position: string,
  lineLabel: string,
): CatalogueLayout {
  const pos = position.trim().toUpperCase();
  const line = lineLabel.trim();
  if (!pos || !line) {
    return layout;
  }
  const existing = layout.extraLines[pos] ?? [];
  if (existing.includes(line)) {
    return layout;
  }
  return {
    ...layout,
    extraLines: {
      ...layout.extraLines,
      [pos]: [...existing, line],
    },
  };
}

export function hideBundledAtom(
  layout: CatalogueLayout,
  atomId: string,
): CatalogueLayout {
  if (layout.hiddenBundledIds.includes(atomId)) {
    return layout;
  }
  return {
    ...layout,
    hiddenBundledIds: [...layout.hiddenBundledIds, atomId],
  };
}

export function unhideBundledAtom(
  layout: CatalogueLayout,
  atomId: string,
): CatalogueLayout {
  if (!layout.hiddenBundledIds.includes(atomId)) {
    return layout;
  }
  return {
    ...layout,
    hiddenBundledIds: layout.hiddenBundledIds.filter((id) => id !== atomId),
  };
}
