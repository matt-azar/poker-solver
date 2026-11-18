import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../state/equityStore", () => ({
  useEquityStore: {
    getState: () => ({ importDraft: vi.fn() }),
  },
}));

vi.mock("../../state/studyStore", () => ({
  useStudyStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      analysisTab: "equity",
      categories: null,
      equity: {
        pending: false,
        oop_equity: 0.44,
        ip_equity: 0.56,
        equity_distribution: [
          { lo: 0, hi: 0.5, weight: 2 },
          { lo: 0.5, hi: 1, weight: 1 },
        ],
        ip_equity_distribution: [
          { lo: 0, hi: 0.5, weight: 1 },
          { lo: 0.5, hi: 1, weight: 2 },
        ],
        oop_hands: [
          { combo: "2c3d", equity: 0.2, weight: 1 },
          { combo: "AhAd", equity: 0.8, weight: 1 },
        ],
        ip_hands: [
          { combo: "2c3h", equity: 0.15, weight: 1 },
          { combo: "KcKd", equity: 0.85, weight: 1 },
        ],
      },
      loadCategories: vi.fn(),
      loadEquity: vi.fn(),
      currentNode: { id: "root", player: 0 },
      solutionId: "s1",
      setWorkspace: vi.fn(),
    }),
}));

vi.mock("../../domain/equity/transfer", () => ({
  draftFromStudyNode: () => ({ ok: false as const, reason: "stub" }),
}));

describe("AnalysisDockPanel equity tab", () => {
  afterEach(() => {
    cleanup();
  });

  it("drops Not chip EV and composition tables, shows OOP vs IP chart", async () => {
    const { AnalysisDockPanel } = await import("./AnalysisDockPanel");
    render(<AnalysisDockPanel />);

    expect(screen.getByText("Equity (fraction of pot).")).toBeTruthy();
    expect(screen.queryByText(/Not chip EV/i)).toBeNull();
    expect(screen.queryByText("Range composition")).toBeNull();
    expect(screen.queryByText("Top hands in filter")).toBeNull();
    expect(screen.queryByText("Filter mass")).toBeNull();

    expect(screen.getByText("Equity chart")).toBeTruthy();
    const chart = screen.getByLabelText("OOP versus IP equity distribution chart");
    expect(chart).toBeTruthy();
    expect(chart.querySelector(".equity-chart-line--oop")).toBeTruthy();
    expect(chart.querySelector(".equity-chart-line--ip")).toBeTruthy();
    expect(document.querySelector(".equity-chart-legend")).toBeTruthy();
  });
});
