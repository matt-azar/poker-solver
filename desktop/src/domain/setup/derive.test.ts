import { describe, expect, it } from "vitest";
import {
  DEFAULT_RAKE_ENVIRONMENT,
  DEFAULT_STARTING_STACK_BB,
  assignSrpSeats,
  derivePostflopPotAndStacks,
  inferSizeMeaning,
  parseStakesLabelStackBb,
  potTypeFromActions,
  profileActionsToSetupActions,
  resolveStartingStackBb,
  seatsForCoVsBbSrp,
  stakesLabelImpliesStack,
} from "./derive";

describe("SRP seat assignment", () => {
  it("assigns BB to OOP and CO to IP for CO vs BB SRP", () => {
    expect(seatsForCoVsBbSrp()).toEqual({ oop: "BB", ip: "CO" });
    expect(assignSrpSeats("CO", "BB")).toEqual({ oop: "BB", ip: "CO" });
    expect(assignSrpSeats("btn", "bb")).toEqual({ oop: "BB", ip: "BTN" });
  });
});

describe("stakes labels vs stack depth", () => {
  it("does not treat 100NL as 100bb without profile or preference", () => {
    expect(stakesLabelImpliesStack("100NL")).toBe(false);
    expect(parseStakesLabelStackBb("100NL")).toBeUndefined();
    expect(parseStakesLabelStackBb("200NL")).toBeUndefined();
    expect(parseStakesLabelStackBb("100bb")).toBeUndefined();
  });

  it("defaults silent stack to 100bb without reading NL labels", () => {
    expect(resolveStartingStackBb({})).toEqual({
      stackBb: DEFAULT_STARTING_STACK_BB,
      source: "default",
    });
    expect(resolveStartingStackBb({ explicitStackBb: 150 }).source).toBe(
      "explicit",
    );
    expect(DEFAULT_RAKE_ENVIRONMENT).toBe("cEV");
  });

  it("classifies pot type from aggressive preflop actions", () => {
    expect(
      potTypeFromActions([{ kind: "open" }, { kind: "call" }, { kind: "fold" }]),
    ).toBe("SRP");
    expect(
      potTypeFromActions([
        { kind: "open" },
        { kind: "raise" },
        { kind: "call" },
      ]),
    ).toBe("3BP");
    expect(
      potTypeFromActions([
        { kind: "open" },
        { kind: "raise" },
        { kind: "raise" },
      ]),
    ).toBe("4BP");
  });
});

describe("sizeMeaning inference and profile conversion", () => {
  it("tags profile call sizes as add and open/raise as to", () => {
    const converted = profileActionsToSetupActions([
      { position: "BTN", kind: "open", sizeBb: 2.5 },
      { position: "BB", kind: "raise", sizeBb: 10 },
      { position: "BTN", kind: "call", sizeBb: 7.5 },
    ]);
    expect(converted).toEqual([
      { seat: "BTN", action: "open", sizeBb: 2.5, sizeMeaning: "to" },
      { seat: "BB", action: "raise", sizeBb: 10, sizeMeaning: "to" },
      { seat: "BTN", action: "call", sizeBb: 7.5, sizeMeaning: "add" },
    ]);
  });

  it("infers call sizeMeaning: to when size equals facing, add when current+size matches", () => {
    expect(
      inferSizeMeaning({
        action: "call",
        sizeBb: 2.5,
        currentContrib: 1,
        facingBb: 2.5,
      }),
    ).toBe("to");
    expect(
      inferSizeMeaning({
        action: "call",
        sizeBb: 1.5,
        currentContrib: 1,
        facingBb: 2.5,
      }),
    ).toBe("add");
    expect(
      inferSizeMeaning({
        action: "call",
        sizeBb: 7.5,
        currentContrib: 2.5,
        facingBb: 10,
      }),
    ).toBe("add");
    expect(
      inferSizeMeaning({
        action: "open",
        sizeBb: 2.5,
        currentContrib: 0,
        facingBb: 1,
      }),
    ).toBe("to");
  });
});

describe("derivePostflopPotAndStacks", () => {
  it("derives 5.5bb pot and 97.5bb stack for 100bb / 2.5bb CO vs BB SRP", () => {
    const result = derivePostflopPotAndStacks({
      startingStackBb: 100,
      openSizeBb: 2.5,
    });
    expect(result.potBb).toBeCloseTo(5.5, 10);
    expect(result.stackBb).toBeCloseTo(97.5, 10);
    expect(result.invested).toEqual({ oop: 2.5, ip: 2.5 });
    expect(result.assumptions.some((line) => /rake not deducted/i.test(line))).toBe(
      true,
    );
    expect(result.incompleteReason).toBeUndefined();
  });

  it("honors explicit action history with the same totals", () => {
    const result = derivePostflopPotAndStacks({
      startingStackBb: 100,
      openSizeBb: 2.5,
      openerSeat: "CO",
      callerSeat: "BB",
      actions: [
        { seat: "SB", action: "fold" },
        { seat: "CO", action: "open", sizeBb: 2.5 },
        { seat: "BB", action: "call", sizeBb: 2.5 },
      ],
    });
    expect(result.potBb).toBeCloseTo(5.5, 10);
    expect(result.stackBb).toBeCloseTo(97.5, 10);
  });

  it("derives SRP when BB call size is profile add-semantics (1.5)", () => {
    const result = derivePostflopPotAndStacks({
      startingStackBb: 100,
      openSizeBb: 2.5,
      openerSeat: "CO",
      callerSeat: "BB",
      actions: profileActionsToSetupActions([
        { position: "SB", kind: "fold" },
        { position: "CO", kind: "open", sizeBb: 2.5 },
        { position: "BB", kind: "call", sizeBb: 1.5 },
      ]),
    });
    expect(result.potBb).toBeCloseTo(5.5, 10);
    expect(result.stackBb).toBeCloseTo(97.5, 10);
    expect(result.invested).toEqual({ oop: 2.5, ip: 2.5 });
  });

  it("derives 3BP pot 20.5 / stack 90 with folded SB and call add 7.5", () => {
    const result = derivePostflopPotAndStacks({
      startingStackBb: 100,
      openSizeBb: 2.5,
      openerSeat: "BTN",
      callerSeat: "BB",
      actions: profileActionsToSetupActions([
        { position: "UTG", kind: "fold" },
        { position: "HJ", kind: "fold" },
        { position: "CO", kind: "fold" },
        { position: "BTN", kind: "open", sizeBb: 2.5 },
        { position: "SB", kind: "fold" },
        { position: "BB", kind: "raise", sizeBb: 10 },
        { position: "BTN", kind: "call", sizeBb: 7.5 },
      ]),
    });
    expect(result.potBb).toBeCloseTo(20.5, 10);
    expect(result.stackBb).toBeCloseTo(90, 10);
    expect(result.invested).toEqual({ oop: 10, ip: 10 });
  });

  it("derives 4BP pot/stacks including folded blinds", () => {
    // BTN open 2.5, BB raise to 10, BTN 4-bet to 25, BB call adds 15; SB folds.
    const result = derivePostflopPotAndStacks({
      startingStackBb: 100,
      openSizeBb: 2.5,
      openerSeat: "BTN",
      callerSeat: "BB",
      actions: [
        { seat: "UTG", action: "fold" },
        { seat: "BTN", action: "open", sizeBb: 2.5, sizeMeaning: "to" },
        { seat: "SB", action: "fold" },
        { seat: "BB", action: "raise", sizeBb: 10, sizeMeaning: "to" },
        { seat: "BTN", action: "raise", sizeBb: 25, sizeMeaning: "to" },
        { seat: "BB", action: "call", sizeBb: 15, sizeMeaning: "add" },
      ],
    });
    expect(result.potBb).toBeCloseTo(50.5, 10); // 0.5 + 25 + 25
    expect(result.stackBb).toBeCloseTo(75, 10);
    expect(result.invested).toEqual({ oop: 25, ip: 25 });
  });

  it("keeps antes additive and still skips rake", () => {
    const result = derivePostflopPotAndStacks({
      startingStackBb: 100,
      openSizeBb: 2.5,
      anteBb: 0.1,
    });
    expect(result.potBb).toBeCloseTo(5.6, 10);
    expect(result.stackBb).toBeCloseTo(97.5, 10);
  });

  it("marks incomplete when aggressive sizes are missing (no invented SRP sizes)", () => {
    const result = derivePostflopPotAndStacks({
      startingStackBb: 100,
      openSizeBb: 2.5,
      openerSeat: "BTN",
      callerSeat: "BB",
      actions: [
        { seat: "BTN", action: "open" },
        { seat: "BB", action: "raise" },
        { seat: "BTN", action: "call" },
      ],
    });
    expect(result.incompleteReason).toMatch(/Missing sizeBb/i);
  });
});
