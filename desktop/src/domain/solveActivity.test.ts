import { describe, expect, it } from "vitest";
import { engineActivityMessage, phaseLabel, statusMetrics } from "./solveActivity";

describe("solveActivity", () => {
  it("maps phases to short study labels", () => {
    expect(phaseLabel("solving")).toBe("Solving");
    expect(phaseLabel("pause_requested")).toBe("Pausing");
    expect(phaseLabel("complete")).toBe("Complete");
  });

  it("builds a solving activity line with iters and Nash gap", () => {
    const message = engineActivityMessage(
      "solving",
      {
        iterations: 40,
        iterations_requested: 200,
        nash_gap: 1.5,
        pot: 100,
        runtime_seconds: 4,
      },
      "",
    );
    expect(message).toContain("Solving");
    expect(message).toContain("40 / 200 iters");
    expect(message).toContain("1.50% pot");
    expect(message).toContain("10.0 it/s");
  });

  it("exposes tabular status metrics", () => {
    const metrics = statusMetrics({
      iterations: 12,
      iterations_requested: 100,
      player0_expected_utility: 3.25,
      nash_gap: 2,
      pot: 100,
      runtime_seconds: 2,
      engine_allocated: 2 * 1024 * 1024,
    });
    expect(metrics.iterations).toBe("12");
    expect(metrics.target).toBe("100");
    expect(metrics.ev).toBe("3.250");
    expect(metrics.nash).toContain("2.00% pot");
    expect(metrics.rate).toBe("6.0/s");
    expect(metrics.memory).toBe("2.0 MiB");
  });
});
