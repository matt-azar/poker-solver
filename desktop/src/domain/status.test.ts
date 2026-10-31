import { describe, expect, it } from "vitest";
import { gapSamplesFromStatus, statusRootEv, statusRootNodeId } from "./status";

describe("status helpers", () => {
  it("reads explorer gap_series", () => {
    const samples = gapSamplesFromStatus({
      samples: 3,
      gap_series: [
        { iterations: 10, value: 1, nash_gap: 2 },
        { iterations: 20, value: 0.5, nash_gap: 1 },
      ],
    });
    expect(samples).toHaveLength(2);
    expect(samples[0]).toEqual({ iteration: 10, nash_gap: 2, value: 1 });
  });

  it("maps root EV and node id fields", () => {
    expect(
      statusRootEv({ player0_expected_utility: 50.5, value: 1 }),
    ).toBeCloseTo(50.5, 12);
    expect(statusRootNodeId({ root_node_id: "p0.t-1.r-1" })).toBe("p0.t-1.r-1");
  });
});
