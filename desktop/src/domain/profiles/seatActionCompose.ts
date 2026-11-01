import type { PotType } from "../setup/types";
import type { SeatActionRange } from "./seatActionTypes";

export interface ComposeSpotRequest {
  potType: PotType;
  /** Postflop OOP seat. */
  oopPosition: string;
  /** Postflop IP seat. */
  ipPosition: string;
  /** Preflop opener seat when known (defaults to ip for SRP). */
  openerPosition?: string;
  openSizeBb?: number;
  stackBb?: number;
}

export interface ComposeSpotResult {
  oopRange?: string;
  ipRange?: string;
  oopAtom?: SeatActionRange;
  ipAtom?: SeatActionRange;
  missing: string[];
  summary: string[];
}

function norm(pos: string): string {
  return pos.trim().toUpperCase() === "BU" ? "BTN" : pos.trim().toUpperCase();
}

function findAtom(
  catalogue: readonly SeatActionRange[],
  pred: (a: SeatActionRange) => boolean,
): SeatActionRange | undefined {
  const hits = catalogue.filter(pred);
  if (hits.length === 0) return undefined;
  // Prefer non-irregular / population_estimate, then shortest id.
  hits.sort((a, b) => {
    const aIr = a.provenance.classification === "unknown" ? 1 : 0;
    const bIr = b.provenance.classification === "unknown" ? 1 : 0;
    if (aIr !== bIr) return aIr - bIr;
    return a.id.localeCompare(b.id);
  });
  return hits[0];
}

/**
 * Compose Build OOP/IP range strings from seat×action atoms.
 * SRP: IP ≈ opener open; OOP ≈ blind call vs opener.
 * 3BP: OOP ≈ 3bettor; IP ≈ caller vs 3bet (when BB 3bets and opener calls).
 */
export function composeSpotFromSeatActions(
  catalogue: readonly SeatActionRange[],
  req: ComposeSpotRequest,
): ComposeSpotResult {
  const oop = norm(req.oopPosition);
  const ip = norm(req.ipPosition);
  const opener = norm(req.openerPosition ?? (req.potType === "SRP" ? ip : ip));
  const missing: string[] = [];
  const summary: string[] = [];

  if (req.potType === "SRP") {
    const openAtom = findAtom(
      catalogue,
      (a) =>
        a.action === "open" &&
        a.vsAction === "none" &&
        norm(a.heroPosition) === opener,
    );
    const callAtom = findAtom(
      catalogue,
      (a) =>
        a.action === "call" &&
        a.vsAction === "open" &&
        norm(a.heroPosition) === oop &&
        (!a.villainPosition || norm(a.villainPosition) === opener),
    );
    if (!openAtom) {
      missing.push(`${opener} open`);
    }
    if (!callAtom) {
      missing.push(`${oop} call vs ${opener} open`);
    }
    if (openAtom) {
      summary.push(`IP from seat×action ${openAtom.id}`);
    }
    if (callAtom) {
      summary.push(`OOP from seat×action ${callAtom.id}`);
    }
    return {
      oopRange: callAtom?.range,
      ipRange: openAtom?.range,
      oopAtom: callAtom,
      ipAtom: openAtom,
      missing,
      summary,
    };
  }

  if (req.potType === "3BP") {
    // Common cash line: opener (IP) opens, BB (OOP) 3bets, opener calls.
    const threeBetAtom = findAtom(
      catalogue,
      (a) =>
        a.action === "three_bet" &&
        a.vsAction === "open" &&
        norm(a.heroPosition) === oop &&
        (!a.villainPosition || norm(a.villainPosition) === opener),
    );
    const callVs3bet = findAtom(
      catalogue,
      (a) =>
        a.action === "call" &&
        a.vsAction === "three_bet" &&
        norm(a.heroPosition) === ip &&
        (!a.villainPosition || norm(a.villainPosition) === oop),
    );
    if (!threeBetAtom) {
      missing.push(`${oop} 3bet vs ${opener} open`);
    }
    if (!callVs3bet) {
      missing.push(`${ip} call vs ${oop} 3bet`);
    }
    if (threeBetAtom) summary.push(`OOP from seat×action ${threeBetAtom.id}`);
    if (callVs3bet) summary.push(`IP from seat×action ${callVs3bet.id}`);
    return {
      oopRange: threeBetAtom?.range,
      ipRange: callVs3bet?.range,
      oopAtom: threeBetAtom,
      ipAtom: callVs3bet,
      missing,
      summary,
    };
  }

  // 4BP: OOP often the 4bettor or cold — keep conservative missing list.
  missing.push(`4BP composition not fully mapped yet for ${oop}/${ip}`);
  return { missing, summary };
}
