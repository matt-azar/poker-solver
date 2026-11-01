import { parseRangeText, comboCount } from "../range";
import {
  SEAT_ACTION_SCHEMA_VERSION,
  type SeatActionKind,
  type SeatActionRange,
} from "./seatActionTypes";

const POS_ALIASES: Record<string, string> = {
  BU: "BTN",
  BTN: "BTN",
  CO: "CO",
  HJ: "HJ",
  LJ: "LJ",
  UTG: "UTG",
  SB: "SB",
  BB: "BB",
  MP: "MP",
  EP: "EP",
};

function normPos(raw: string): string {
  const key = raw.trim().toUpperCase();
  return POS_ALIASES[key] ?? key;
}

function slugId(parts: string[]): string {
  return parts
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export interface FilenameParseResult {
  heroPosition: string;
  villainPosition?: string;
  action: SeatActionKind;
  vsAction: SeatActionKind | "none";
  openSizeBb?: number;
  startingStackBb?: number;
  displayName: string;
  id: string;
  tags: string[];
  /** True when the name is too irregular to claim a clean seat×action mapping. */
  irregular?: boolean;
}

/**
 * Parse Matt's Ranges.zip-style filenames into seat×action metadata.
 * Examples: CO.txt, BBvCOcall.txt, COvBB3bcall.txt, HU3bcall200bb.txt
 */
export function parseSeatActionFilename(filename: string): FilenameParseResult {
  const base = filename.replace(/\.txt$/i, "").trim();
  const tags: string[] = [];
  let working = base;
  let startingStackBb: number | undefined;
  let openSizeBb: number | undefined;

  const stackMatch = working.match(/(\d+)\s*bb$/i);
  if (stackMatch) {
    startingStackBb = Number(stackMatch[1]);
    working = working.slice(0, stackMatch.index).replace(/[_-]+$/, "");
    tags.push(`${startingStackBb}bb`);
  }

  if (/norake/i.test(working)) {
    tags.push("norake");
    working = working.replace(/norake/i, "");
  }
  if (/gto/i.test(working)) {
    tags.push("gto");
    working = working.replace(/gto/i, "");
  }

  // Heads-up family: HU2.5, HU2.5call, HU3b4x, HU3bcall, HU4b2.5x, HU4bcall
  if (/^HU/i.test(working)) {
    const hu = working.slice(2);
    if (/^2\.5call$/i.test(hu)) {
      openSizeBb = 2.5;
      return {
        heroPosition: "BB",
        villainPosition: "SB",
        action: "call",
        vsAction: "open",
        openSizeBb,
        startingStackBb,
        displayName: `HU BB call vs SB 2.5x open`,
        id: slugId(["hu", "bb", "call", "vs", "sb", "open", "2.5x", ...tags]),
        tags,
      };
    }
    if (/^2\.5$/i.test(hu)) {
      openSizeBb = 2.5;
      return {
        heroPosition: "SB",
        action: "open",
        vsAction: "none",
        openSizeBb,
        startingStackBb,
        displayName: `HU SB open 2.5x`,
        id: slugId(["hu", "sb", "open", "2.5x", ...tags]),
        tags,
      };
    }
    if (/^3bcall/i.test(hu)) {
      return {
        heroPosition: "SB",
        villainPosition: "BB",
        action: "call",
        vsAction: "three_bet",
        startingStackBb,
        displayName: `HU SB call vs BB 3bet`,
        id: slugId(["hu", "sb", "call", "vs", "bb", "3bet", ...tags]),
        tags,
      };
    }
    if (/^3b4x$/i.test(hu)) {
      openSizeBb = 4;
      return {
        heroPosition: "BB",
        villainPosition: "SB",
        action: "three_bet",
        vsAction: "open",
        openSizeBb,
        startingStackBb,
        displayName: `HU BB 3bet 4x vs SB open`,
        id: slugId(["hu", "bb", "3bet", "4x", ...tags]),
        tags,
      };
    }
    if (/^3b$/i.test(hu) || /^3b\d/i.test(hu)) {
      return {
        heroPosition: "BB",
        villainPosition: "SB",
        action: "three_bet",
        vsAction: "open",
        startingStackBb,
        displayName: `HU BB 3bet vs SB open`,
        id: slugId(["hu", "bb", "3bet", ...tags]),
        tags,
      };
    }
    if (/^4bcall/i.test(hu)) {
      return {
        heroPosition: "BB",
        villainPosition: "SB",
        action: "four_bet_call",
        vsAction: "four_bet",
        startingStackBb,
        displayName: `HU call vs 4bet`,
        id: slugId(["hu", "call", "vs", "4bet", ...tags]),
        tags,
      };
    }
    if (/^4b2\.5x$/i.test(hu)) {
      openSizeBb = 2.5;
      return {
        heroPosition: "SB",
        villainPosition: "BB",
        action: "four_bet",
        vsAction: "three_bet",
        openSizeBb,
        startingStackBb,
        displayName: `HU SB 4bet vs BB 3bet (2.5x line)`,
        id: slugId(["hu", "sb", "4bet", "2.5x", ...tags]),
        tags,
      };
    }
  }

  // Flat helpers: SBflatvHJ, SBvCOflat
  const flatVs = working.match(/^(\w+)flatv(\w+)$/i);
  if (flatVs) {
    const hero = normPos(flatVs[1]!);
    const vill = normPos(flatVs[2]!);
    return {
      heroPosition: hero,
      villainPosition: vill,
      action: "call",
      vsAction: "open",
      startingStackBb,
      displayName: `${hero} flat vs ${vill} open`,
      id: slugId([hero, "call", "vs", vill, "open", "flat", ...tags]),
      tags: [...tags, "flat"],
    };
  }
  const vsFlat = working.match(/^(\w+)v(\w+)flat$/i);
  if (vsFlat) {
    const hero = normPos(vsFlat[1]!);
    const vill = normPos(vsFlat[2]!);
    return {
      heroPosition: hero,
      villainPosition: vill,
      action: "call",
      vsAction: "open",
      startingStackBb,
      displayName: `${hero} flat vs ${vill} open`,
      id: slugId([hero, "call", "vs", vill, "open", "flat", ...tags]),
      tags: [...tags, "flat"],
    };
  }

  // Bare open charts: CO, BU, HJ, LJ, SB
  if (/^(BU|BTN|CO|HJ|LJ|UTG|SB|BB|MP|EP)$/i.test(working)) {
    const hero = normPos(working);
    return {
      heroPosition: hero,
      action: "open",
      vsAction: "none",
      startingStackBb,
      displayName: `${hero} open`,
      id: slugId([hero, "open", ...tags]),
      tags,
    };
  }

  // Hero v Villain + action suffix
  // Villain seat is letters only so suffixes like 3bcall are not absorbed into the seat.
  const vs = working.match(
    /^([A-Za-z]+)v([A-Za-z]+)(4bcall|4bj|4b|3bcall|3bet|3b|call)$/i,
  );
  if (vs) {
    const hero = normPos(vs[1]!);
    const vill = normPos(vs[2]!);
    const suffix = vs[3]!.toLowerCase();
    let action: SeatActionKind = "unknown";
    let vsAction: SeatActionKind | "none" = "open";
    let label = "";
    switch (suffix) {
      case "call":
        action = "call";
        vsAction = "open";
        label = `${hero} call vs ${vill} open`;
        break;
      case "3bet":
      case "3b":
        action = "three_bet";
        vsAction = "open";
        label = `${hero} 3bet vs ${vill} open`;
        break;
      case "3bcall":
        action = "call";
        vsAction = "three_bet";
        label = `${hero} call vs ${vill} 3bet`;
        break;
      case "4b":
        action = "four_bet";
        vsAction = "three_bet";
        label = `${hero} 4bet vs ${vill} 3bet`;
        break;
      case "4bcall":
        action = "four_bet_call";
        vsAction = "four_bet";
        label = `${hero} call vs ${vill} 4bet`;
        break;
      case "4bj":
        action = "jam";
        vsAction = "four_bet";
        label = `${hero} jam vs ${vill} 4bet`;
        break;
      default:
        break;
    }
    return {
      heroPosition: hero,
      villainPosition: vill,
      action,
      vsAction,
      startingStackBb,
      displayName: label || `${hero} vs ${vill} (${suffix})`,
      id: slugId([hero, action, "vs", vill, vsAction, ...tags]),
      tags,
    };
  }

  return {
    heroPosition: "UNKNOWN",
    action: "unknown",
    vsAction: "none",
    startingStackBb,
    displayName: base,
    id: slugId(["misc", base, ...tags]),
    tags: [...tags, "irregular"],
    irregular: true,
  };
}

export function seatActionFromTextFile(
  filename: string,
  rangeText: string,
  sourcePath: string,
): SeatActionRange {
  const meta = parseSeatActionFilename(filename);
  const range = rangeText.trim().replace(/\s+/g, "");
  // Validate parseability (throws only on catastrophic issues — parser is lenient).
  const combos = comboCount(parseRangeText(range), "");
  if (combos <= 0 && !meta.irregular) {
    throw new Error(`Seat-action range empty after parse: ${filename}`);
  }
  return {
    schemaVersion: SEAT_ACTION_SCHEMA_VERSION,
    id: meta.id,
    dataRevision: "1",
    displayName: meta.displayName,
    heroPosition: meta.heroPosition,
    villainPosition: meta.villainPosition,
    action: meta.action,
    vsAction: meta.vsAction,
    range,
    format: meta.tags.includes("irregular") ? "unknown" : "cash_6max",
    startingStackBb: meta.startingStackBb,
    openSizeBb: meta.openSizeBb,
    labels: {
      stakes: meta.tags.includes("norake") ? "cEV" : undefined,
      intendedUse: "user_pack_seat_action",
      pool: meta.tags.includes("gto") ? "gto_labelled" : undefined,
    },
    provenance: {
      source: sourcePath,
      classification: meta.irregular ? "unknown" : "population_estimate",
      notes: meta.irregular
        ? `Irregular filename; kept as misc atom from ${filename}`
        : `Seat×action pack from user Ranges.zip (${filename}). Stack/rake often unspecified in source.`,
    },
  };
}
