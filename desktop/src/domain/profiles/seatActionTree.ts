import type { CatalogueLayout } from "./catalogueLayout";
import { isFiledPlacement, seatSlotKey } from "./seatActionPlacement";
import type { SeatActionKind, SeatActionRange } from "./seatActionTypes";

/** Pio-style catalogue node: a position or preflop line, or a pickable range. */
export type SeatActionTreeNode =
  | {
      kind: "branch";
      id: string;
      label: string;
      /** Position code for this branch (set on position and line folders). */
      position?: string;
      /** Line folder label when this is a vs-line under a position. */
      lineLabel?: string | null;
      children: SeatActionTreeNode[];
    }
  | {
      kind: "leaf";
      id: string;
      label: string;
      atom: SeatActionRange;
      /** True when this leaf is a user override of a bundled chart. */
      overridden?: boolean;
    };

const POSITION_ORDER = ["UTG", "EP", "LJ", "HJ", "MP", "CO", "BTN", "SB", "BB"];

const ACTION_ORDER: SeatActionKind[] = [
  "open",
  "call",
  "three_bet",
  "four_bet",
  "four_bet_call",
  "five_bet",
  "jam",
  "fold",
  "unknown",
];

function positionRank(position: string): number {
  const index = POSITION_ORDER.indexOf(position.toUpperCase());
  return index === -1 ? POSITION_ORDER.length + 1 : index;
}

function actionRank(action: SeatActionKind): number {
  const index = ACTION_ORDER.indexOf(action);
  return index === -1 ? ACTION_ORDER.length : index;
}

function facingLabel(vs: SeatActionRange["vsAction"]): string {
  switch (vs) {
    case "none":
      return "";
    case "open":
      return "open";
    case "three_bet":
      return "3bet";
    case "four_bet":
      return "4bet";
    case "five_bet":
      return "5bet";
    case "call":
      return "call";
    case "jam":
      return "jam";
    case "fold":
      return "fold";
    default:
      return vs;
  }
}

/** Folder name for a non-open line, e.g. "vs CO open". */
export function lineFolder(atom: SeatActionRange): string | null {
  if (atom.action === "open" || atom.vsAction === "none" || !atom.villainPosition) {
    return null;
  }
  const facing = facingLabel(atom.vsAction);
  return facing ? `vs ${atom.villainPosition} ${facing}` : `vs ${atom.villainPosition}`;
}

function leaf(
  atom: SeatActionRange,
  label: string,
  overridden = false,
): SeatActionTreeNode {
  return { kind: "leaf", id: atom.id, label, atom, overridden };
}

function sortAtoms(atoms: SeatActionRange[]): SeatActionRange[] {
  return [...atoms].sort((a, b) => {
    const byAction = actionRank(a.action) - actionRank(b.action);
    if (byAction !== 0) return byAction;
    return a.displayName.localeCompare(b.displayName);
  });
}

function leavesOrFolder(
  id: string,
  label: string,
  atoms: SeatActionRange[],
  meta: { position: string; lineLabel: string | null },
  overriddenIds: Set<string>,
): SeatActionTreeNode {
  const sorted = sortAtoms(atoms);
  if (sorted.length === 1) {
    const only = sorted[0]!;
    const overridden = overriddenIds.has(only.id);
    // Keep folder labels (Open / vs CO open) for bundled singles; show the
    // custom name when a user chart replaced that slot.
    return leaf(only, overridden ? only.displayName : label, overridden);
  }
  return {
    kind: "branch",
    id,
    label,
    position: meta.position,
    lineLabel: meta.lineLabel,
    children: sorted.map((atom) =>
      leaf(atom, atom.displayName, overriddenIds.has(atom.id)),
    ),
  };
}

function displayLabel(
  branchId: string,
  fallback: string,
  renames: Record<string, string>,
): string {
  return renames[branchId]?.trim() || fallback;
}

/**
 * Merge bundled + user atoms for the tree: filed user saves override bundled
 * charts in the same seat×action slot; unfiled USER saves are omitted (shown
 * separately). Hidden bundled ids are dropped.
 */
export function mergeAtomsForCatalogueTree(
  atoms: readonly SeatActionRange[],
  options?: {
    isUserImport?: (id: string) => boolean;
    hiddenBundledIds?: readonly string[];
  },
): { atoms: SeatActionRange[]; overriddenUserIds: Set<string> } {
  const hidden = new Set(options?.hiddenBundledIds ?? []);
  const isUser = options?.isUserImport ?? (() => false);

  const filedUser: SeatActionRange[] = [];
  const bundledVisible: SeatActionRange[] = [];
  const bundledSlots = new Set<string>();
  for (const atom of atoms) {
    if (isUser(atom.id)) {
      if (isFiledPlacement(atom)) {
        filedUser.push(atom);
      }
      continue;
    }
    bundledSlots.add(seatSlotKey(atom));
    if (!hidden.has(atom.id)) {
      bundledVisible.push(atom);
    }
  }

  const userSlots = new Map<string, SeatActionRange>();
  for (const atom of filedUser) {
    userSlots.set(seatSlotKey(atom), atom);
  }

  const overriddenUserIds = new Set<string>();
  const visibleBundled: SeatActionRange[] = [];
  for (const atom of bundledVisible) {
    const slot = seatSlotKey(atom);
    const override = userSlots.get(slot);
    if (override) {
      overriddenUserIds.add(override.id);
      continue;
    }
    visibleBundled.push(atom);
  }
  // User charts that replaced a (now hidden) bundled slot still count as overrides.
  for (const atom of filedUser) {
    if (bundledSlots.has(seatSlotKey(atom))) {
      overriddenUserIds.add(atom.id);
    }
  }

  return {
    atoms: [...visibleBundled, ...filedUser],
    overriddenUserIds,
  };
}

/**
 * Group seat×action ranges as position → preflop line, matching Pio's
 * range browser (open, then each facing action).
 */
export function buildSeatActionTree(
  atoms: readonly SeatActionRange[],
  layout?: Partial<CatalogueLayout>,
  options?: { overriddenUserIds?: ReadonlySet<string> },
): SeatActionTreeNode[] {
  const renames = layout?.renames ?? {};
  const extraPositions = layout?.extraPositions ?? [];
  const extraLines = layout?.extraLines ?? {};
  const overriddenIds = new Set(options?.overriddenUserIds ?? []);

  const byPosition = new Map<string, SeatActionRange[]>();
  for (const atom of atoms) {
    const position = (atom.heroPosition || "Other").toUpperCase();
    if (position === "USER") {
      continue;
    }
    const list = byPosition.get(position) ?? [];
    list.push(atom);
    byPosition.set(position, list);
  }
  for (const position of extraPositions) {
    const key = position.toUpperCase();
    if (!byPosition.has(key)) {
      byPosition.set(key, []);
    }
  }

  const positions = [...byPosition.keys()].sort((a, b) => {
    const rank = positionRank(a) - positionRank(b);
    if (rank !== 0) return rank;
    return a.localeCompare(b);
  });

  return positions.map((position) => {
    const group = byPosition.get(position) ?? [];
    const opens: SeatActionRange[] = [];
    const lines = new Map<string, SeatActionRange[]>();
    for (const atom of group) {
      const folder = lineFolder(atom);
      if (!folder) {
        opens.push(atom);
      } else {
        const list = lines.get(folder) ?? [];
        list.push(atom);
        lines.set(folder, list);
      }
    }
    for (const line of extraLines[position] ?? []) {
      if (!lines.has(line) && !/^open$/i.test(line)) {
        lines.set(line, []);
      }
    }

    const children: SeatActionTreeNode[] = [];
    const openId = `${position}-open`;
    if (opens.length > 0 || (extraLines[position] ?? []).some((line) => /^open$/i.test(line))) {
      if (opens.length > 0) {
        children.push(
          leavesOrFolder(
            openId,
            displayLabel(openId, "Open", renames),
            opens,
            { position, lineLabel: null },
            overriddenIds,
          ),
        );
      } else {
        children.push({
          kind: "branch",
          id: openId,
          label: displayLabel(openId, "Open", renames),
          position,
          lineLabel: null,
          children: [],
        });
      }
    } else if (group.length === 0) {
      // Empty custom position: still expose an Open folder to save into.
      children.push({
        kind: "branch",
        id: openId,
        label: displayLabel(openId, "Open", renames),
        position,
        lineLabel: null,
        children: [],
      });
    }

    const lineKeys = [...lines.keys()].sort((a, b) => a.localeCompare(b));
    for (const key of lineKeys) {
      const lineId = `${position}-${key}`;
      const lineAtoms = lines.get(key) ?? [];
      if (lineAtoms.length === 0) {
        children.push({
          kind: "branch",
          id: lineId,
          label: displayLabel(lineId, key, renames),
          position,
          lineLabel: key,
          children: [],
        });
      } else {
        children.push(
          leavesOrFolder(
            lineId,
            displayLabel(lineId, key, renames),
            lineAtoms,
            { position, lineLabel: key },
            overriddenIds,
          ),
        );
      }
    }

    return {
      kind: "branch" as const,
      id: position,
      label: displayLabel(position, position, renames),
      position,
      lineLabel: undefined,
      children,
    };
  });
}
