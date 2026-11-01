import { describe, expect, it } from "vitest";
import {
  assignSrpSeats,
  derivePostflopPotAndStacks,
  parseStakesLabelStackBb,
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

  it("keeps antes additive and still skips rake", () => {
    const result = derivePostflopPotAndStacks({
      startingStackBb: 100,
      openSizeBb: 2.5,
      anteBb: 0.1,
    });
    expect(result.potBb).toBeCloseTo(5.6, 10);
    expect(result.stackBb).toBeCloseTo(97.5, 10);
  });
});
