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
            player: 0,
          },
          {
            card: "Kd",
            dealProbability: 0.02,
            dealProbabilityDefined: true,
            reach: 0.4,
            reachDefined: true,
            zeroReach: false,
            available: true,
            reason: null,
            resolvedNodeId: "p12.t40.r-1",
            actions: ["Check", "Bet 50"],
            frequencies: [0.5, 0.5],
            player: 0,
            ev: -20,
            evDefined: true,
            equity: 0.1,
            equityDefined: true,
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
      pathTrail: [
        {
          nodeId: "root",
          label: "Root",
          rawLabel: "Root",
          kind: "root",
          street: "turn",
          actor: null,
        },
        {
          nodeId: "n-x",
          label: "Check",
          rawLabel: "Check",
          kind: "action",
          street: "turn",
          actor: "OOP",
        },
        {
          nodeId: "n-b",
          label: "Bet 50",
          rawLabel: "Bet 50",
          kind: "action",
          street: "turn",
          actor: "IP",
          sizePot: 100,
          toCall: 0,
        },
        {
          nodeId: "n-c",
          label: "Call",
          rawLabel: "Call",
          kind: "action",
          street: "turn",
          actor: "OOP",
        },
        {
          nodeId: "p12.t40.r-1",
          label: "Check",
          rawLabel: "Check",
          kind: "action",
          street: "turn",
          actor: "OOP",
        },
      ],
      draft: { pot: 100 },
      status: { pot: 100 },
      evDisplayBasis: "local",
    }),
}));

const { LineCardReport, lineCardHeatColor } = await import("./LineCardReport");

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
    expect(screen.getByText("Compare runouts")).toBeTruthy();
    const line = screen.getByTestId("line-card-line");
    expect(line.textContent).toContain("x/b50/c/x");
    expect(line.textContent).not.toContain("Check/Bet");
    expect(screen.getByTestId("line-card-seat").textContent).toBe("OOP");
    const ace = document.querySelector('[data-card="As"]');
    expect(ace?.querySelector(".line-card-cell__badge")?.textContent).toBe("A♠");
    expect(ace?.textContent).not.toContain("As");
    expect(document.querySelector('[data-card="Kd"] .line-card-cell__badge')?.textContent).toBe(
      "K♦",
    );
    expect(screen.getAllByText("25.0%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("75.0%").length).toBeGreaterThan(0);
    expect(screen.getByText("Line unavailable on this card")).toBeTruthy();
    fireEvent.click(screen.getByTitle("As"));
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
    const ace = document.querySelector('[data-card="As"]') as HTMLElement;
    const king = document.querySelector('[data-card="Kd"]') as HTMLElement;
    const deuce = document.querySelector('[data-card="2c"]') as HTMLElement;
    expect(ace.getAttribute("data-heat")).toBe("true");
    expect(king.getAttribute("data-heat")).toBe("true");
    expect(deuce.getAttribute("data-heat")).toBe("false");
    expect(hueOf(ace.getAttribute("data-heat-color"))).toBeGreaterThan(
      hueOf(king.getAttribute("data-heat-color")),
    );
    expect(ace.style.backgroundColor).not.toBe("");
    expect(king.style.backgroundColor).not.toBe(ace.style.backgroundColor);
    expect(king.querySelector(".line-card-cell__badge")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Equity" }));
    expect(await screen.findByText("42.0%")).toBeTruthy();
    expect(getEquity).toHaveBeenCalled();
    expect(ace.getAttribute("data-heat")).toBe("true");
    expect(screen.getByTestId("line-card-line").textContent).toContain("equity");
    expect(screen.getByTestId("line-card-line").textContent).not.toContain(
      "check-down",
    );

    fireEvent.click(screen.getByRole("button", { name: "Deal probability" }));
    expect(screen.getAllByText("2.0%").length).toBeGreaterThan(0);
    expect(screen.queryByText("25.0%")).toBeNull();
    expect(ace.getAttribute("data-heat")).toBe("false");
    expect(king.getAttribute("data-heat")).toBe("false");
  });
});

function hueOf(color: string | null): number {
  const match = color?.match(/hsl\((\d+)/);
  return match ? Number(match[1]) : -1;
}

describe("lineCardHeatColor", () => {
  it("paints low values red and high values green", () => {
    expect(hueOf(lineCardHeatColor(-10, -10, 10))).toBe(0);
    expect(hueOf(lineCardHeatColor(10, -10, 10))).toBe(120);
    expect(hueOf(lineCardHeatColor(4, 4, 4))).toBe(60);
  });
});
