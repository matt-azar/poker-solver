import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    pot: 100,
    to_call: 0,
    reach_defined: true,
    actions: ["Check", "Bet 30", "Bet 150 all-in"],
    combos: ["AhAd", "7h2d", "6h5h"],
    strategy: [
      [0.1, 0.9, 0],
      [0.2, 0, 0.8],
      [0.1, 0.9, 0],
    ],
    reach: [1, 1, 1],
    marginal: [1, 1, 1],
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
      actionFilter: null,
    });
  });

  it("keeps </> compact and places Bluffs / Value bets under the button", async () => {
    useStudyStore.setState({
      solutionId: "s1",
      currentNode: decisionNode(),
      equity: {
        oop_hands: [
          { combo: "AhAd", equity: 0.8, weight: 1 },
          { combo: "7h2d", equity: 0.1, weight: 1 },
          { combo: "6h5h", equity: 0.12, weight: 1 },
        ],
        ip_hands: [],
      },
      nodeValues: null,
      status: { analysis_revision: 1, pot: 100 },
    });

    render(<ValueBluffsPanel />);

    const toggle = screen.getByRole("button", {
      name: /Bluffs: equity < threshold/i,
    });
    expect(toggle.textContent?.trim()).toBe("<");
    expect(within(toggle).queryByText("Bluffs")).toBeNull();
    expect(screen.getByText("Bluffs")).toBeTruthy();

    await waitFor(() => {
      const cells = useValueBluffsHighlightStore.getState().highlightCells;
      expect(cells).not.toBeNull();
      expect(cells?.has("72o")).toBe(true);
      expect(cells?.has("65s")).toBe(true);
      expect(cells?.has("AA")).toBe(false);
    });

    fireEvent.click(toggle);
    const valueToggle = screen.getByRole("button", {
      name: /Value bets: equity > threshold/i,
    });
    expect(valueToggle.textContent?.trim()).toBe(">");
    expect(within(valueToggle).queryByText("Value bets")).toBeNull();
    expect(screen.getByText("Value bets")).toBeTruthy();

    await waitFor(() => {
      const cells = useValueBluffsHighlightStore.getState().highlightCells;
      expect(cells?.has("AA")).toBe(true);
      expect(cells?.has("72o")).toBe(false);
    });
  });

  it("filters the hand list and matrix highlight by bet-size toggles without navigating", async () => {
    useStudyStore.setState({
      solutionId: "s1",
      currentNode: decisionNode(),
      equity: {
        oop_hands: [
          { combo: "AhAd", equity: 0.8, weight: 1 },
          { combo: "7h2d", equity: 0.1, weight: 1 },
          { combo: "6h5h", equity: 0.12, weight: 1 },
        ],
        ip_hands: [],
      },
      status: { analysis_revision: 1, pot: 100 },
      actionFilter: null,
    });

    render(<ValueBluffsPanel />);

    const sizeGroup = screen.getByRole("group", {
      name: /Value \/ Bluffs bet sizes/i,
    });
    const sizeButtons = within(sizeGroup).getAllByRole("button");
    expect(sizeButtons).toHaveLength(2);
    expect(sizeButtons[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(sizeButtons[1]!.getAttribute("aria-pressed")).toBe("true");

    await waitFor(() => {
      expect(screen.getByText("7h2d")).toBeTruthy();
      expect(screen.getByText("6h5h")).toBeTruthy();
    });

    // Turn off the first betting size (Bet 30 / b30) — keeps 7h2d (all-in).
    fireEvent.click(sizeButtons[0]!);
    expect(sizeButtons[0]!.getAttribute("aria-pressed")).toBe("false");
    expect(useStudyStore.getState().actionFilter).toBeNull();
    expect(useStudyStore.getState().currentNode?.node_id).toBe("p0");

    await waitFor(() => {
      expect(screen.queryByText("6h5h")).toBeNull();
      expect(screen.getByText("7h2d")).toBeTruthy();
      const cells = useValueBluffsHighlightStore.getState().highlightCells;
      expect(cells?.has("72o")).toBe(true);
      expect(cells?.has("65s")).toBe(false);
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
      status: { analysis_revision: 1, pot: 100 },
    });
    const view = render(<ValueBluffsPanel />);
    await waitFor(() => {
      expect(useValueBluffsHighlightStore.getState().highlightCells).not.toBeNull();
    });
    view.unmount();
    expect(useValueBluffsHighlightStore.getState().highlightCells).toBeNull();
  });
});
