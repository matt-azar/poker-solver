import type { PreflopAction } from "./types";

export interface BlindStructure {
  sb: number;
  bb: number;
}

export interface DerivePostflopInput {
  startingStackBb: number;
  openSizeBb: number;
  blinds?: BlindStructure;
  /** Optional ante total contributed to the pot before action (sum across seats). */
  anteBb?: number;
  /**
   * Preflop action history. When omitted, assumes standard SRP:
   * SB folds, opener opens to openSizeBb, BB calls.
   */
  actions?: PreflopAction[];
  /** Opener seat label (defaults to CO). */
  openerSeat?: string;
  /** Calling blind seat that becomes OOP (defaults to BB). */
  callerSeat?: string;
}

export interface DerivePostflopResult {
  potBb: number;
  /** Effective remaining stack for each active player after the preflop investment. */
  stackBb: number;
  invested: { oop: number; ip: number };
  assumptions: string[];
}

const DEFAULT_BLINDS: BlindStructure = { sb: 0.5, bb: 1 };

/**
 * Stakes labels (e.g. "100NL") never imply stack depth. 100NL ≠ 100bb.
 * Stack comes only from an explicit request, selected profile, or saved preference.
 */
export function stakesLabelImpliesStack(
  _stakesLabel: string | null | undefined,
): false {
  return false;
}

export function parseStakesLabelStackBb(
  _stakesLabel: string | null | undefined,
): number | undefined {
  return undefined;
}

export interface PostflopSeatAssignment {
  oop: string;
  ip: string;
}

/**
 * Heads-up postflop seats after a single-raised pot: the blind that called is OOP,
 * the preflop aggressor is IP. CO vs BB SRP → BB OOP, CO IP.
 */
export function assignSrpSeats(
  openerSeat: string,
  callerSeat: string,
): PostflopSeatAssignment {
  return {
    oop: callerSeat.trim().toUpperCase(),
    ip: openerSeat.trim().toUpperCase(),
  };
}

export function seatsForCoVsBbSrp(): PostflopSeatAssignment {
  return assignSrpSeats("CO", "BB");
}

function normalizeSeat(seat: string): string {
  return seat.trim().toUpperCase();
}

function defaultSrpActions(
  opener: string,
  caller: string,
  openSizeBb: number,
): PreflopAction[] {
  return [
    { seat: "SB", action: "fold" },
    { seat: opener, action: "open", sizeBb: openSizeBb },
    { seat: caller, action: "call", sizeBb: openSizeBb },
  ];
}

/**
 * Deterministic postflop pot/stack derivation from preflop history.
 * Units stay in bb. Do not deduct rake here — engine rake accounting is separate.
 *
 * Canonical CO vs BB SRP: 100bb start, 2.5bb open, SB folds, BB calls
 * → pot 5.5bb (0.5 + 2.5 + 2.5), remaining 97.5bb each.
 */
export function derivePostflopPotAndStacks(
  input: DerivePostflopInput,
): DerivePostflopResult {
  const blinds = input.blinds ?? DEFAULT_BLINDS;
  const opener = normalizeSeat(input.openerSeat ?? "CO");
  const caller = normalizeSeat(input.callerSeat ?? "BB");
  const assumptions: string[] = [];

  if (!input.blinds) {
    assumptions.push("blinds default to 0.5/1 bb");
  }
  if (!input.anteBb) {
    assumptions.push("no antes");
  }
  assumptions.push("rake not deducted in derivation");

  const usingDefaultActions = !input.actions;
  const actions =
    input.actions ?? defaultSrpActions(opener, caller, input.openSizeBb);

  if (usingDefaultActions) {
    assumptions.push(
      `standard SRP: SB folds, ${opener} opens ${input.openSizeBb}bb, ${caller} calls`,
    );
  }

  // Track total chips each seat has put into the pot (including blinds).
  const contrib: Record<string, number> = {
    SB: blinds.sb,
    BB: blinds.bb,
  };

  let openTo = 0;
  for (const step of actions) {
    const seat = normalizeSeat(step.seat);
    if (step.action === "fold") {
      continue;
    }
    if (
      step.action === "open" ||
      step.action === "raise" ||
      step.action === "bet"
    ) {
      const size = step.sizeBb ?? input.openSizeBb;
      openTo = size;
      contrib[seat] = size;
      continue;
    }
    if (step.action === "call") {
      const target = step.sizeBb ?? (openTo || input.openSizeBb);
      contrib[seat] = target;
      continue;
    }
    if (step.action === "all_in" && step.sizeBb !== undefined) {
      if (seat === opener) {
        openTo = step.sizeBb;
      }
      contrib[seat] = step.sizeBb;
    }
  }

  const openerInvested = contrib[opener] ?? input.openSizeBb;
  const callerInvested = contrib[caller] ?? input.openSizeBb;

  // Dead money from folded SB (and any other folders that posted).
  let deadBb = 0;
  const foldedSeats = new Set(
    actions
      .filter((step) => step.action === "fold")
      .map((step) => normalizeSeat(step.seat)),
  );
  for (const seat of foldedSeats) {
    deadBb += contrib[seat] ?? 0;
  }

  const potBb = (input.anteBb ?? 0) + deadBb + openerInvested + callerInvested;
  const oopRemaining = input.startingStackBb - callerInvested;
  const ipRemaining = input.startingStackBb - openerInvested;

  return {
    potBb,
    stackBb: Math.min(oopRemaining, ipRemaining),
    invested: { oop: callerInvested, ip: openerInvested },
    assumptions,
  };
}
