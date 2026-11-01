import { describe, expect, it } from "vitest";
import { solveControlFlags } from "./solveControls";

describe("solveControlFlags", () => {
  it("allows Solve when idle and disables Continue/Pause/Stop", () => {
    expect(solveControlFlags("idle")).toEqual({
      busy: false,
      canSolve: true,
      canContinue: false,
      canPause: false,
      canStop: false,
    });
  });

  it("allows only Pause and Stop while solving", () => {
    expect(solveControlFlags("solving")).toEqual({
      busy: true,
      canSolve: false,
      canContinue: false,
      canPause: true,
      canStop: true,
    });
  });

  it("allows Continue after pause or complete, not while busy", () => {
    expect(solveControlFlags("paused").canContinue).toBe(true);
    expect(solveControlFlags("complete").canContinue).toBe(true);
    expect(solveControlFlags("solving").canContinue).toBe(false);
    expect(solveControlFlags("building").canContinue).toBe(false);
    expect(solveControlFlags("stop_requested").canContinue).toBe(false);
  });

  it("keeps Stop available while pause is draining", () => {
    const flags = solveControlFlags("pause_requested");
    expect(flags.canPause).toBe(false);
    expect(flags.canStop).toBe(true);
    expect(flags.canSolve).toBe(false);
    expect(flags.canContinue).toBe(false);
  });
});
