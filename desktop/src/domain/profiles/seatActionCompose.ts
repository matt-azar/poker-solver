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
  /**
   * Optional stakes/rake label. Never required for compose — position +
   * preflop action win. Soft preference only when both request and atom are tagged.
   */
  stakesLabel?: string;
}

/** One chart used (or considered) while composing a spot. */
export interface ComposeChartRef {
  id: string;
  dataRevision: string | number;
  displayName: string;
  role: "oop" | "ip" | "alternative";
  classification: SeatActionRange["provenance"]["classification"];
  /** Human differences vs the request (open size, stack, stakes tag, …). */
  differences: string[];
}

export interface ComposeSpotResult {
  oopRange?: string;
  ipRange?: string;
  oopAtom?: SeatActionRange;
  ipAtom?: SeatActionRange;
  /** Charts that supplied the composed ranges (id + revision). */
  chartsUsed: ComposeChartRef[];
  /** Compatible-but-not-preferred atoms (mismatched open/stack/stakes tag). */
  alternatives: ComposeChartRef[];
  missing: string[];
  summary: string[];
}

function norm(pos: string): string {
  return pos.trim().toUpperCase() === "BU" ? "BTN" : pos.trim().toUpperCase();
}

function normStakes(label: string | undefined): string | undefined {
  const raw = label?.trim();
  return raw ? raw.toUpperCase().replace(/\s+/g, "") : undefined;
}

function chartRef(
  atom: SeatActionRange,
  role: ComposeChartRef["role"],
  differences: string[] = [],
): ComposeChartRef {
  return {
    id: atom.id,
    dataRevision: atom.dataRevision,
    displayName: atom.displayName,
    role,
    classification: atom.provenance.classification,
    differences,
  };
}

function atomDifferences(
  atom: SeatActionRange,
  req: ComposeSpotRequest,
): string[] {
  const diffs: string[] = [];
  if (
    req.openSizeBb !== undefined &&
    atom.openSizeBb !== undefined &&
    atom.openSizeBb !== req.openSizeBb
  ) {
    diffs.push(`open size ${atom.openSizeBb}bb (requested ${req.openSizeBb}bb)`);
  }
  if (
    req.stackBb !== undefined &&
    atom.startingStackBb !== undefined &&
    atom.startingStackBb !== req.stackBb
  ) {
    diffs.push(`stack ${atom.startingStackBb}bb (requested ${req.stackBb}bb)`);
  }
  const wantStakes = normStakes(req.stakesLabel);
  const gotStakes = normStakes(atom.labels?.stakes);
  if (wantStakes && gotStakes && wantStakes !== gotStakes) {
    diffs.push(`stakes tag ${gotStakes} (requested ${wantStakes})`);
  } else if (wantStakes && !gotStakes) {
    diffs.push("chart untagged for stakes/rake (position×action still used)");
  }
  return diffs;
}

/**
 * Rank hits for position×action: prefer open-size / stack agreement when both
 * sides are tagged. Untagged stakes never disqualify. Soft stakes preference
 * only when both request and atom carry a label.
 */
function pickAtom(
  catalogue: readonly SeatActionRange[],
  pred: (a: SeatActionRange) => boolean,
  req: ComposeSpotRequest,
): { chosen?: SeatActionRange; alternatives: SeatActionRange[] } {
  const hits = catalogue.filter(pred);
  if (hits.length === 0) return { alternatives: [] };

  const scored = hits.map((atom) => {
    let score = 0;
    const diffs = atomDifferences(atom, req);
    if (
      req.openSizeBb !== undefined &&
      atom.openSizeBb !== undefined &&
      atom.openSizeBb === req.openSizeBb
    ) {
      score += 4;
    } else if (req.openSizeBb !== undefined && atom.openSizeBb === undefined) {
      score += 1; // untagged open size — still usable
    }
    if (
      req.stackBb !== undefined &&
      atom.startingStackBb !== undefined &&
      atom.startingStackBb === req.stackBb
    ) {
      score += 3;
    } else if (
      req.stackBb !== undefined &&
      atom.startingStackBb === undefined
    ) {
      score += 1;
    }
    const wantStakes = normStakes(req.stakesLabel);
    const gotStakes = normStakes(atom.labels?.stakes);
    if (wantStakes && gotStakes && wantStakes === gotStakes) {
      score += 1; // soft preference only
    }
    if (atom.provenance.classification === "unknown") {
      score -= 2;
    }
    if (atom.provenance.classification === "synthetic_fixture") {
      score -= 1;
    }
    // Hard open-size mismatch still ranks below agreement but stays eligible.
    if (
      req.openSizeBb !== undefined &&
      atom.openSizeBb !== undefined &&
      atom.openSizeBb !== req.openSizeBb
    ) {
      score -= 3;
    }
    if (
      req.stackBb !== undefined &&
      atom.startingStackBb !== undefined &&
      atom.startingStackBb !== req.stackBb
    ) {
      score -= 2;
    }
    return { atom, score, diffs };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.atom.id.localeCompare(b.atom.id);
  });

  const chosen = scored[0]!.atom;
  const alternatives = scored.slice(1).map((s) => s.atom);
  return { chosen, alternatives };
}

function roleSummary(
  role: "OOP" | "IP",
  atom: SeatActionRange,
  diffs: string[],
): string {
  const rev = String(atom.dataRevision);
  const mismatch =
    diffs.length > 0 ? ` · labeled alternative traits: ${diffs.join("; ")}` : "";
  return `${role} from seat×action ${atom.id}@${rev}${mismatch}`;
}

/**
 * Compose Build OOP/IP range strings from seat×action atoms.
 * Selection is driven by **position + preflop action**. Open size / stack are
 * soft preferences when charts carry that metadata. Missing stakes tags never
 * block compose. SRP: IP ≈ opener open; OOP ≈ blind call vs opener.
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
  const chartsUsed: ComposeChartRef[] = [];
  const alternatives: ComposeChartRef[] = [];

  const pushAlts = (
    alts: SeatActionRange[],
    role: "oop" | "ip",
  ) => {
    for (const atom of alts.slice(0, 4)) {
      alternatives.push(chartRef(atom, "alternative", atomDifferences(atom, req)));
    }
    void role;
  };

  if (req.potType === "SRP") {
    const openPick = pickAtom(
      catalogue,
      (a) =>
        a.action === "open" &&
        a.vsAction === "none" &&
        norm(a.heroPosition) === opener,
      req,
    );
    const callPick = pickAtom(
      catalogue,
      (a) =>
        a.action === "call" &&
        a.vsAction === "open" &&
        norm(a.heroPosition) === oop &&
        (!a.villainPosition || norm(a.villainPosition) === opener),
      req,
    );
    if (!openPick.chosen) {
      missing.push(`${opener} open`);
    }
    if (!callPick.chosen) {
      missing.push(`${oop} call vs ${opener} open`);
    }
    const openAtom = openPick.chosen;
    const callAtom = callPick.chosen;
    if (openAtom) {
      const diffs = atomDifferences(openAtom, req);
      chartsUsed.push(chartRef(openAtom, "ip", diffs));
      summary.push(roleSummary("IP", openAtom, diffs));
      pushAlts(openPick.alternatives, "ip");
    }
    if (callAtom) {
      const diffs = atomDifferences(callAtom, req);
      chartsUsed.push(chartRef(callAtom, "oop", diffs));
      summary.push(roleSummary("OOP", callAtom, diffs));
      pushAlts(callPick.alternatives, "oop");
    }
    if (chartsUsed.some((c) => c.differences.length > 0)) {
      summary.push(
        "Some charts differ on open size / stack / stakes tag — see labeled alternatives; position×action still composed",
      );
    }
    return {
      oopRange: callAtom?.range,
      ipRange: openAtom?.range,
      oopAtom: callAtom,
      ipAtom: openAtom,
      chartsUsed,
      alternatives,
      missing,
      summary,
    };
  }

  if (req.potType === "3BP") {
    // Common cash line: opener (IP) opens, BB (OOP) 3bets, opener calls.
    const threeBetPick = pickAtom(
      catalogue,
      (a) =>
        a.action === "three_bet" &&
        a.vsAction === "open" &&
        norm(a.heroPosition) === oop &&
        (!a.villainPosition || norm(a.villainPosition) === opener),
      req,
    );
    const callVs3betPick = pickAtom(
      catalogue,
      (a) =>
        a.action === "call" &&
        a.vsAction === "three_bet" &&
        norm(a.heroPosition) === ip &&
        (!a.villainPosition || norm(a.villainPosition) === oop),
      req,
    );
    if (!threeBetPick.chosen) {
      missing.push(`${oop} 3bet vs ${opener} open`);
    }
    if (!callVs3betPick.chosen) {
      missing.push(`${ip} call vs ${oop} 3bet`);
    }
    const threeBetAtom = threeBetPick.chosen;
    const callVs3bet = callVs3betPick.chosen;
    if (threeBetAtom) {
      const diffs = atomDifferences(threeBetAtom, req);
      chartsUsed.push(chartRef(threeBetAtom, "oop", diffs));
      summary.push(roleSummary("OOP", threeBetAtom, diffs));
      pushAlts(threeBetPick.alternatives, "oop");
    }
    if (callVs3bet) {
      const diffs = atomDifferences(callVs3bet, req);
      chartsUsed.push(chartRef(callVs3bet, "ip", diffs));
      summary.push(roleSummary("IP", callVs3bet, diffs));
      pushAlts(callVs3betPick.alternatives, "ip");
    }
    if (chartsUsed.some((c) => c.differences.length > 0)) {
      summary.push(
        "Some charts differ on open size / stack / stakes tag — see labeled alternatives; position×action still composed",
      );
    }
    return {
      oopRange: threeBetAtom?.range,
      ipRange: callVs3bet?.range,
      oopAtom: threeBetAtom,
      ipAtom: callVs3bet,
      chartsUsed,
      alternatives,
      missing,
      summary,
    };
  }

  // 4BP: OOP often the 4bettor or cold — keep conservative missing list.
  missing.push(`4BP composition not fully mapped yet for ${oop}/${ip}`);
  return { chartsUsed, alternatives, missing, summary };
}
