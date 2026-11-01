import type { SeatActionKind, SeatActionRange } from "./seatActionTypes";

/** Pio-style catalogue node: a position or preflop line, or a pickable range. */
export type SeatActionTreeNode =
  | {
      kind: "branch";
      id: string;
      label: string;
      children: SeatActionTreeNode[];
    }
  | {
      kind: "leaf";
      id: string;
      label: string;
      atom: SeatActionRange;
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
function lineFolder(atom: SeatActionRange): string | null {
  if (atom.action === "open" || atom.vsAction === "none" || !atom.villainPosition) {
    return null;
  }
  const facing = facingLabel(atom.vsAction);
  return facing ? `vs ${atom.villainPosition} ${facing}` : `vs ${atom.villainPosition}`;
}

function leaf(atom: SeatActionRange, label: string): SeatActionTreeNode {
  return { kind: "leaf", id: atom.id, label, atom };
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
): SeatActionTreeNode {
  const sorted = sortAtoms(atoms);
  if (sorted.length === 1) {
    return leaf(sorted[0]!, label);
  }
  return {
    kind: "branch",
    id,
    label,
    children: sorted.map((atom) => leaf(atom, atom.displayName)),
  };
}

/**
 * Group seat×action ranges as position → preflop line, matching Pio's
 * range browser (open, then each facing action).
 */
export function buildSeatActionTree(atoms: readonly SeatActionRange[]): SeatActionTreeNode[] {
  const byPosition = new Map<string, SeatActionRange[]>();
  for (const atom of atoms) {
    const position = (atom.heroPosition || "Other").toUpperCase();
    const list = byPosition.get(position) ?? [];
    list.push(atom);
    byPosition.set(position, list);
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

    const children: SeatActionTreeNode[] = [];
    if (opens.length > 0) {
      children.push(leavesOrFolder(`${position}-open`, "Open", opens));
    }
    const lineKeys = [...lines.keys()].sort((a, b) => a.localeCompare(b));
    for (const key of lineKeys) {
      children.push(
        leavesOrFolder(`${position}-${key}`, key, lines.get(key) ?? []),
      );
    }

    return {
      kind: "branch" as const,
      id: position,
      label: position,
      children,
    };
  });
}
