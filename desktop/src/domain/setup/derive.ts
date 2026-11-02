import type {
  PreflopAction,
  PreflopActionKind,
  PreflopSizeMeaning,
  PotType,
} from "./types";

/**
 * Default preflop starting stack when the player does not mention stack depth.
 * Independent of rake/stakes labels such as "100NL" (those never imply stack).
 */
export const DEFAULT_STARTING_STACK_BB = 100;

/**
 * Default rake / stakes-environment key when the player does not name one.
 * cEV = chip EV (no rake). Distinct from labels like "100NL" that select a
 * rake structure; never implies stack depth.
 */
export const DEFAULT_RAKE_ENVIRONMENT = "cEV";

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
   * Do not omit for 3BP/4BP — callers must pass full history or leave pot/stack
   * unresolved rather than inventing an SRP.
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
  /**
   * When set, sizes required for a faithful ledger were missing and the
   * numbers must not be treated as authoritative (resolver should ask).
   */
  incompleteReason?: string;
}

const DEFAULT_BLINDS: BlindStructure = { sb: 0.5, bb: 1 };
const SIZE_EPS = 1e-6;

/**
 * Rake/stakes-environment labels (e.g. "100NL") never imply stack depth.
 * 100NL ≠ 100bb. Unspecified stacks default via {@link DEFAULT_STARTING_STACK_BB}
 * in the assistant/resolver — not by parsing the NL label.
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

/**
 * Resolve the starting-stack assumption for matching/derivation.
 * Explicit request/preference wins; otherwise assume 100bb when stacks are silent.
 * Never derive from a rake label such as "100NL".
 */
export function resolveStartingStackBb(args: {
  explicitStackBb?: number;
  preferenceStackBb?: number;
  profileStackBb?: number;
}): { stackBb: number; source: "explicit" | "preference" | "profile" | "default" } {
  if (
    args.explicitStackBb !== undefined &&
    Number.isFinite(args.explicitStackBb) &&
    args.explicitStackBb > 0
  ) {
    return { stackBb: args.explicitStackBb, source: "explicit" };
  }
  if (
    args.preferenceStackBb !== undefined &&
    Number.isFinite(args.preferenceStackBb) &&
    args.preferenceStackBb > 0
  ) {
    return { stackBb: args.preferenceStackBb, source: "preference" };
  }
  if (
    args.profileStackBb !== undefined &&
    Number.isFinite(args.profileStackBb) &&
    args.profileStackBb > 0
  ) {
    return { stackBb: args.profileStackBb, source: "profile" };
  }
  return { stackBb: DEFAULT_STARTING_STACK_BB, source: "default" };
}

/** Classify preflop history into SRP / 3BP / 4BP from aggressive actions. */
export function potTypeFromActions(
  actions: ReadonlyArray<{ kind: string }>,
): PotType | undefined {
  let aggressive = 0;
  for (const step of actions) {
    const kind = step.kind.toLowerCase();
    if (kind === "open" || kind === "raise" || kind === "bet") {
      aggressive += 1;
    }
  }
  if (aggressive <= 0) {
    return undefined;
  }
  if (aggressive === 1) {
    return "SRP";
  }
  if (aggressive === 2) {
    return "3BP";
  }
  return "4BP";
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
  const raw = seat.trim().toUpperCase();
  return raw === "BU" ? "BTN" : raw;
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= SIZE_EPS;
}

function defaultSrpActions(
  opener: string,
  caller: string,
  openSizeBb: number,
): PreflopAction[] {
  return [
    { seat: "SB", action: "fold" },
    { seat: opener, action: "open", sizeBb: openSizeBb, sizeMeaning: "to" },
    { seat: caller, action: "call", sizeBb: openSizeBb, sizeMeaning: "to" },
  ];
}

/**
 * Convert catalogue/profile `{position, kind, sizeBb}` history into setup
 * `{seat, action, sizeBb, sizeMeaning}` actions.
 *
 * Profile call sizes are amount **added**; open/raise sizes are total committed.
 */
export function profileActionsToSetupActions(
  actions: ReadonlyArray<{
    position: string;
    kind: string;
    sizeBb?: number;
  }>,
): PreflopAction[] {
  return actions.map((step) => {
    const kind = step.kind.toLowerCase() as PreflopActionKind;
    const action: PreflopAction = {
      seat: normalizeSeat(step.position),
      action: kind,
    };
    if (step.sizeBb !== undefined && Number.isFinite(step.sizeBb)) {
      action.sizeBb = step.sizeBb;
      if (kind === "call") {
        action.sizeMeaning = "add";
      } else if (
        kind === "open" ||
        kind === "raise" ||
        kind === "bet" ||
        kind === "all_in"
      ) {
        action.sizeMeaning = "to";
      }
    }
    return action;
  });
}

/**
 * Infer size semantics when `sizeMeaning` is omitted.
 *
 * Rules:
 * - open / raise / bet / all_in → `"to"` (total committed).
 * - call with size ≈ facing amount → `"to"`.
 * - call with current + size ≈ facing (and size ≠ facing) → `"add"`
 *   (catalogue/profile convention).
 * - call without size → match facing as `"to"`.
 */
export function inferSizeMeaning(args: {
  action: PreflopActionKind;
  sizeBb: number | undefined;
  currentContrib: number;
  facingBb: number;
  explicit?: PreflopSizeMeaning;
}): PreflopSizeMeaning {
  if (args.explicit) {
    return args.explicit;
  }
  if (
    args.action === "open" ||
    args.action === "raise" ||
    args.action === "bet" ||
    args.action === "all_in"
  ) {
    return "to";
  }
  if (args.action !== "call" || args.sizeBb === undefined) {
    return "to";
  }
  const facing = args.facingBb;
  if (facing > 0 && nearlyEqual(args.sizeBb, facing)) {
    return "to";
  }
  if (
    facing > 0 &&
    nearlyEqual(args.currentContrib + args.sizeBb, facing)
  ) {
    return "add";
  }
  // Catalogue convention fallback for calls: treat as chips added.
  return "add";
}

/**
 * Deterministic postflop pot/stack derivation from preflop history.
 * Units stay in bb. Do not deduct rake here — engine rake accounting is separate.
 *
 * Contribution ledger: blinds seed the pot; each action updates that seat's
 * total committed chips. Folded blinds stay as dead money.
 *
 * Canonical CO vs BB SRP: 100bb start, 2.5bb open, SB folds, BB calls
 * → pot 5.5bb (0.5 + 2.5 + 2.5), remaining 97.5bb each.
 *
 * Canonical BTN vs BB 3BP: open 2.5, BB raise to 10, BTN call adds 7.5,
 * SB folds → pot 20.5bb (0.5 + 10 + 10), remaining 90bb each.
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

  let facingBb = Math.max(blinds.bb, 0);
  let incompleteReason: string | undefined;

  for (const step of actions) {
    const seat = normalizeSeat(step.seat);
    if (step.action === "fold" || step.action === "check") {
      continue;
    }

    const current = contrib[seat] ?? 0;
    const meaning = inferSizeMeaning({
      action: step.action,
      sizeBb: step.sizeBb,
      currentContrib: current,
      facingBb,
      explicit: step.sizeMeaning,
    });

    if (
      (step.action === "open" ||
        step.action === "raise" ||
        step.action === "bet" ||
        step.action === "all_in") &&
      step.sizeBb === undefined &&
      !(usingDefaultActions && input.openSizeBb > 0)
    ) {
      incompleteReason =
        incompleteReason ??
        `Missing sizeBb for ${seat} ${step.action}; cannot derive pot without inventing sizes`;
      continue;
    }

    if (step.action === "call") {
      const size = step.sizeBb;
      if (size === undefined) {
        // Match the current facing amount as a total commitment.
        const target = facingBb > 0 ? facingBb : input.openSizeBb;
        contrib[seat] = Math.max(current, target);
        continue;
      }
      if (meaning === "add") {
        contrib[seat] = current + size;
      } else {
        contrib[seat] = size;
      }
      continue;
    }

    if (
      step.action === "open" ||
      step.action === "raise" ||
      step.action === "bet" ||
      step.action === "all_in"
    ) {
      const size = step.sizeBb ?? input.openSizeBb;
      const next =
        meaning === "add" ? current + size : size;
      contrib[seat] = next;
      facingBb = Math.max(facingBb, next);
    }
  }

  const openerInvested = contrib[opener] ?? input.openSizeBb;
  const callerInvested = contrib[caller] ?? input.openSizeBb;

  // Dead money from folded blinds / seats that posted then folded.
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
    incompleteReason,
  };
}
