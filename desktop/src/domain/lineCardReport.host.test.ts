import { describe, expect, it } from "vitest";
import { lineCardReportFromHostBody } from "./lineCardReport";

describe("lineCardReportFromHostBody", () => {
  it("maps Zig line_card_report rows for flop→turn compare", () => {
    const model = lineCardReportFromHostBody(
      {
        pending: false,
        kind: "line_card_report",
        report_node_id: "p2.t11.r-1",
        chance_node_id: "p1.t-1.r-1",
        vary_street: "turn",
        action_labels: ["Check", "Bet 50"],
        rows: [
          {
            card: "As",
            deal_probability: 0.02,
            available: true,
            reason: null,
            resolved_node_id: "p2.t40.r-1",
            joint: 0.4,
            player: 0,
            actions: ["Check", "Bet 50"],
            frequencies: [0.25, 0.75],
          },
          {
            card: "2c",
            deal_probability: 0.02,
            available: false,
            reason: "Action set differs on this card",
            resolved_node_id: "p2.t3.r-1",
            joint: null,
            player: null,
            actions: ["Check"],
            frequencies: [1],
          },
        ],
      },
      {
        reportNodeId: "p2.t11.r-1",
        line: "Check/Check",
        street: "turn",
        solutionId: "s1",
      },
    );
    expect(model).not.toBeNull();
    expect(model!.street).toBe("turn");
    expect(model!.chanceNodeId).toBe("p1.t-1.r-1");
    expect(model!.rows).toHaveLength(2);
    expect(model!.rows[0]?.frequencies[1]).toBeCloseTo(0.75, 12);
    expect(model!.rows[0]?.reach).toBeCloseTo(0.4, 12);
    expect(model!.rows[1]?.available).toBe(false);
  });
});
