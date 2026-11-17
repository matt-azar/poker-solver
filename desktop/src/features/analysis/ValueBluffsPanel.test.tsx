import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../engine/client", () => ({
  engineClient: {
    getNode: vi.fn(),
    getEquity: vi.fn(),
    getValueBluffsPostCall: vi.fn(),
  },
}));

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  }),
});

const { useStudyStore } = await import("../../state/studyStore");
const { useValueBluffsHighlightStore } = await import(
  "../../state/valueBluffsHighlightStore"
);
const { ValueBluffsPanel } = await import("./ValueBluffsPanel");

function decisionNode() {
  return {
    node_id: "p0",
    kind: "decision" as const,
    player: 0,
    reach_defined: true,
    actions: ["Check", "Bet 50"],
    combos: ["AhAd", "7h2d"],
    strategy: [
      [0.1, 0.9],
      [0.2, 0.8],
    ],
    reach: [1, 1],
    marginal: [1, 1],
  };
}

describe("ValueBluffsPanel compare caption + matrix highlight", () => {
  afterEach(() => {
    cleanup();
    useValueBluffsHighlightStore.getState().setHighlightCells(null);
    useStudyStore.setState({
      currentNode: null,
      equity: null,
      nodeValues: null,
      solutionId: null,
      status: null,
    });
  });

  it("labels the compare toggle Bluffs / Value bets and dims via highlight store", async () => {
    useStudyStore.setState({
      solutionId: "s1",
      currentNode: decisionNode(),
      equity: {
        oop_hands: [
          { combo: "AhAd", equity: 0.8, weight: 1 },
          { combo: "7h2d", equity: 0.1, weight: 1 },
        ],
        ip_hands: [],
      },
      nodeValues: null,
      status: { analysis_revision: 1 },
    });

    render(<ValueBluffsPanel />);

    const toggle = screen.getByRole("button", {
      name: /Bluffs: equity < threshold/i,
    });
    expect(toggle.textContent).toContain("Bluffs");
    expect(screen.queryByText("Value bets")).toBeNull();

    await waitFor(() => {
      const cells = useValueBluffsHighlightStore.getState().highlightCells;
      expect(cells).not.toBeNull();
      expect(cells?.has("72o")).toBe(true);
      expect(cells?.has("AA")).toBe(false);
    });

    fireEvent.click(toggle);
    expect(
      screen.getByRole("button", { name: /Value bets: equity > threshold/i }),
    ).toBeTruthy();
    expect(screen.getByText("Value bets")).toBeTruthy();

    await waitFor(() => {
      const cells = useValueBluffsHighlightStore.getState().highlightCells;
      expect(cells?.has("AA")).toBe(true);
      expect(cells?.has("72o")).toBe(false);
    });
  });

  it("clears matrix highlight on unmount", async () => {
    useStudyStore.setState({
      solutionId: "s1",
      currentNode: decisionNode(),
      equity: {
        oop_hands: [{ combo: "7h2d", equity: 0.1, weight: 1 }],
        ip_hands: [],
      },
      status: { analysis_revision: 1 },
    });
    const view = render(<ValueBluffsPanel />);
    await waitFor(() => {
      expect(useValueBluffsHighlightStore.getState().highlightCells).not.toBeNull();
    });
    view.unmount();
    expect(useValueBluffsHighlightStore.getState().highlightCells).toBeNull();
  });
});
