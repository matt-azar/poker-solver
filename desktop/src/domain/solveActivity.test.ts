import { describe, expect, it } from "vitest";
import {
  engineActivityMessage,
  estimateRemainingSeconds,
  phaseLabel,
  statusMetrics,
} from "./solveActivity";

describe("solveActivity", () => {
  it("maps phases to short study labels", () => {
    expect(phaseLabel("solving")).toBe("Solving");
    expect(phaseLabel("pause_requested")).toBe("Pausing");
    expect(phaseLabel("complete")).toBe("Complete");
  });

  it("builds a solving activity line with iters and Pio Accuracy", () => {
    const message = engineActivityMessage(
      "solving",
      {
        iterations: 40,
        iterations_requested: 200,
        // NashConv 1.5 → Pio Accuracy 0.75 chips = 0.75% pot
        nash_gap: 1.5,
        pot: 100,
        runtime_seconds: 4,
      },
      "",
    );
    expect(message).toContain("Solving");
    expect(message).toContain("40 / 200 iters");
    expect(message).toContain("0.75% pot");
    expect(message).toContain("10.0 it/s");
  });

  it("prefers Building copy over a stale Solving fallback while compiling", () => {
    const message = engineActivityMessage(
      "building",
      {
        running: true,
        phase: "compiling",
        iterations: 0,
        iterations_requested: 0,
      },
      "Solving — 0 iterations",
    );
    expect(message).toMatch(/Building public tree/i);
  });

  it("exposes tabular status metrics", () => {
    const metrics = statusMetrics({
      iterations: 12,
      iterations_requested: 100,
      player0_expected_utility: 3.25,
      // NashConv 2 → Accuracy 1 chip = 1% pot
      nash_gap: 2,
      pot: 100,
      runtime_seconds: 2,
      engine_allocated: 2 * 1024 * 1024,
    });
    expect(metrics.iterations).toBe("12");
    expect(metrics.target).toBe("100");
    expect(metrics.ev).toBe("3.250");
    expect(metrics.nash).toContain("1.00% pot");
    expect(metrics.rate).toBe("6.0/s");
    expect(metrics.memory).toBe("2.0 MiB");
    expect(metrics.eta).toBe("—");
  });

  it("sentence-cases an all-lowercase engine failure", () => {
    const message = engineActivityMessage(
      "failed",
      { error: "icm stacks need at least two seats" },
      "",
    );
    expect(message).toBe("ICM stacks need at least two seats");
  });

  it("estimates remaining time from iteration target and rate", () => {
    const seconds = estimateRemainingSeconds({
      running: true,
      iterations: 40,
      iterations_requested: 200,
      runtime_seconds: 4,
    });
    expect(seconds).toBeCloseTo(16, 8);
  });
});
