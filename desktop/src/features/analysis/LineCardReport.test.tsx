import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openRow = vi.hoisted(() => vi.fn());

vi.mock("../../state/studyStore", () => ({
  useStudyStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      lineCardReport: {
        pending: false,
        reportNodeId: "p12.t40.r-1",
        line: "Check/Bet 50/Call/Check",
        street: "turn",
        chanceNodeId: "p0.t-1.r-1",
        actionLabels: ["Check", "Bet 50"],
        rows: [
          {
            card: "As",
            dealProbability: 0.02,
            dealProbabilityDefined: true,
            reach: 0.4,
            reachDefined: true,
            zeroReach: false,
            available: true,
            reason: null,
            resolvedNodeId: "p12.t40.r-1",
            actions: ["Check", "Bet 50"],
            frequencies: [0.25, 0.75],
          },
          {
            card: "2c",
            dealProbability: 0.02,
            dealProbabilityDefined: true,
            reach: null,
            reachDefined: false,
            zeroReach: false,
            available: false,
            reason: "Line unavailable on this card",
            resolvedNodeId: null,
            actions: [],
            frequencies: [],
          },
        ],
        solutionId: "s1",
      },
      loadLineCardReport: vi.fn(),
      openLineCardRow: openRow,
    }),
}));

const { LineCardReport } = await import("./LineCardReport");

describe("LineCardReport", () => {
  beforeEach(() => {
    openRow.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows deal P, reach, and action mix, and opens a resolved row", () => {
    render(<LineCardReport />);
    expect(screen.getByText("Compare cards")).toBeTruthy();
    expect(screen.getByTestId("line-card-line").textContent).toContain("turn");
    expect(screen.getByText("As")).toBeTruthy();
    expect(screen.getAllByText("25.0%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("75.0%").length).toBeGreaterThan(0);
    expect(screen.getByText("Line unavailable on this card")).toBeTruthy();
    fireEvent.click(screen.getByText("As"));
    expect(openRow).toHaveBeenCalledWith("p12.t40.r-1");
  });
});
