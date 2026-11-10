import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openRow = vi.hoisted(() => vi.fn());
const getValues = vi.hoisted(() => vi.fn());
const getEquity = vi.hoisted(() => vi.fn());

vi.mock("../../engine/client", () => ({
  engineClient: {
    getValues,
    getEquity,
  },
}));

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
    getValues.mockReset();
    getEquity.mockReset();
    getValues.mockResolvedValue({
      pending: false,
      node_ev: 12.5,
      node_ev_defined: true,
      utility_basis: "local",
      local_offset: 0,
    });
    getEquity.mockResolvedValue({
      pending: false,
      oop_equity: 0.42,
      ip_equity: 0.58,
    });
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
    const headers = screen.getAllByRole("columnheader");
    expect(headers[0]?.textContent).toBe("2");
    expect(headers[headers.length - 1]?.textContent).toBe("A");
    expect(headers).toHaveLength(13);
    expect(screen.getAllByRole("row")).toHaveLength(5);
  });

  it("toggles cell values among frequencies, EV, equity, and deal probability", async () => {
    render(<LineCardReport />);
    fireEvent.click(screen.getByRole("button", { name: "EV" }));
    expect(await screen.findByText("12.5")).toBeTruthy();
    expect(getValues).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Equity" }));
    expect(await screen.findByText("42.0%")).toBeTruthy();
    expect(getEquity).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Deal probability" }));
    expect(screen.getAllByText("2.0%").length).toBeGreaterThan(0);
    expect(screen.queryByText("25.0%")).toBeNull();
  });
});
