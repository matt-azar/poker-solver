import type { SeatActionKind, SeatActionRange } from "./seatActionTypes";

/** Where a catalogue range sits in the position → line tree. */
export interface SeatPlacement {
  heroPosition: string;
  action: SeatActionKind;
  vsAction: SeatActionKind | "none";
  villainPosition?: string;
}

const FACING_TO_VS: Record<string, SeatActionKind> = {
  open: "open",
  call: "call",
  "3bet": "three_bet",
  three_bet: "three_bet",
  "4bet": "four_bet",
  four_bet: "four_bet",
  "5bet": "five_bet",
  five_bet: "five_bet",
  jam: "jam",
  fold: "fold",
};

/** Stable slot key so a user save can override a bundled chart in the same folder. */
export function seatSlotKey(
  atom: Pick<
    SeatActionRange,
    "heroPosition" | "action" | "vsAction" | "villainPosition"
  >,
): string {
  return [
    (atom.heroPosition || "").trim().toUpperCase(),
    atom.action,
    atom.vsAction,
    (atom.villainPosition || "").trim().toUpperCase(),
  ].join("|");
}

export function placementSlotKey(placement: SeatPlacement): string {
  return seatSlotKey(placement);
}

/** True when the atom is filed under a real seat (not the flat USER bucket). */
export function isFiledPlacement(
  atom: Pick<SeatActionRange, "heroPosition" | "action">,
): boolean {
  const hero = (atom.heroPosition || "").trim().toUpperCase();
  return Boolean(hero) && hero !== "USER" && atom.action !== "unknown";
}

/** Open folder under a position. */
export function openPlacement(heroPosition: string): SeatPlacement {
  return {
    heroPosition: heroPosition.trim().toUpperCase(),
    action: "open",
    vsAction: "none",
  };
}

/**
 * Parse a line folder label like "vs CO open" into placement fields.
 * Returns null when the label is not a vs-line (e.g. "Open").
 */
export function parseLineFolderLabel(
  heroPosition: string,
  label: string,
  action: SeatActionKind = "call",
): SeatPlacement | null {
  const trimmed = label.trim();
  if (!trimmed || /^open$/i.test(trimmed)) {
    return openPlacement(heroPosition);
  }
  const match = trimmed.match(/^vs\s+(\S+)\s+(.+)$/i);
  if (!match) {
    return null;
  }
  const villain = match[1]!.toUpperCase();
  const facingRaw = match[2]!.trim().toLowerCase().replace(/\s+/g, "_");
  const vsAction = FACING_TO_VS[facingRaw] ?? FACING_TO_VS[match[2]!.trim().toLowerCase()];
  if (!vsAction) {
    return null;
  }
  return {
    heroPosition: heroPosition.trim().toUpperCase(),
    villainPosition: villain,
    action,
    vsAction,
  };
}

/** Folder label for a facing line, matching `seatActionTree` grouping. */
export function lineFolderLabel(placement: SeatPlacement): string | null {
  if (placement.action === "open" || placement.vsAction === "none" || !placement.villainPosition) {
    return null;
  }
  const facing =
    placement.vsAction === "three_bet"
      ? "3bet"
      : placement.vsAction === "four_bet"
        ? "4bet"
        : placement.vsAction === "five_bet"
          ? "5bet"
          : placement.vsAction;
  return `vs ${placement.villainPosition.toUpperCase()} ${facing}`;
}

/** Normalize a user-typed position folder name. */
export function normalizePositionName(raw: string): string | null {
  const name = raw.trim().toUpperCase().replace(/\s+/g, "");
  if (!name || name === "USER") {
    return null;
  }
  return name === "BU" ? "BTN" : name;
}
