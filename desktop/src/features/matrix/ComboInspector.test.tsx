import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NodePayload } from "../../domain/types";

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
const { ComboInspector } = await import("./ComboInspector");

const aaNode: NodePayload = {
  node_id: "p0",
  reach_defined: true,
  actions: ["Check", "Bet 50"],
  combos: ["AhAd", "AhAs", "AhAc"],
  marginal: [1, 1, 1],
  strategy: [
    [0.5, 0.5],
    [0.6, 0.4],
    [0.7, 0.3],
  ],
};

describe("ComboInspector", () => {
  beforeEach(() => {
    useStudyStore.setState({
      currentNode: aaNode,
      nodeValues: null,
      selectedCell: { row: 0, col: 0, text: "AA" },
      hoverCell: null,
      lockDraft: { kind: "selected", handIndices: [], probs: [0.5, 0.5] },
      lockDraftBaseline: null,
      lockDrawerOpen: false,
      strategyEditDrawerOpen: false,
      locks: [],
      solutionId: "sol-test",
      strategyEditDraft: { kind: "selected", handIndices: [], probs: [0.5, 0.5] },
      strategyEditDraftBaseline: null,
      strategyEditScope: null,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("does not expose Hands-panel lock drafting controls", () => {
    render(<ComboInspector />);
    expect(screen.queryByRole("button", { name: "Lock selection" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Lock entire hand class" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit strategy" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Select .+ for lock/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unlock" })).toBeNull();
  });

  it("clears a pinned matrix selection without opening the lock drawer", async () => {
    const user = userEvent.setup();
    render(<ComboInspector />);
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(useStudyStore.getState().selectedCell).toBeNull();
    expect(useStudyStore.getState().lockDrawerOpen).toBe(false);
  });

  it("shows Hands empty hint when nothing is hovered or selected", () => {
    useStudyStore.setState({ selectedCell: null, hoverCell: null });
    render(<ComboInspector />);
    expect(screen.getByRole("heading", { name: "Hands" })).toBeTruthy();
    expect(screen.getByText("Hover a hand in the grid.")).toBeTruthy();
  });

  it("lists strategy weight-fill segments and per-action EV across the pair suit grid", () => {
    useStudyStore.setState({
      nodeValues: {
        node_id: "p0",
        pending: false,
        combos: ["AhAd", "AhAs", "AhAc"],
        ev_defined: [true, true, true],
        value: [1.5, 1.2, 0.9],
        action_ev: [
          [0.5, 2.5],
          [0.4, 2.0],
          [0.3, 1.5],
        ],
        utility_basis: "local",
      },
    });
    render(<ComboInspector />);
    // Pairs use 6 suit slots (3 present in this fixture).
    expect(document.querySelectorAll(".hands-combo")).toHaveLength(6);
    expect(
      document.querySelectorAll('.hands-combo[data-present="true"]'),
    ).toHaveLength(3);
    expect(screen.getByText("0.50")).toBeTruthy();
    expect(screen.getByText("2.50")).toBeTruthy();
    expect(
      document.querySelectorAll(
        '.hands-combo[data-present="true"] .hands-combo__weight-fill .hands-combo__seg',
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Reach mass")).toBeNull();
    expect(screen.queryByText("Mixed EV")).toBeNull();
    const present = document.querySelector(
      '.hands-combo[data-present="true"]',
    ) as HTMLElement;
    expect(present.style.getPropertyValue("--mass-fill")).toBe("1");
    expect(present.querySelector(".hands-combo__weight-fill")).toBeTruthy();
    expect(present.querySelector(".inspector-combo__mix")).toBeNull();
  });

  it("scales --mass-fill by relative combo mass", () => {
    useStudyStore.setState({
      currentNode: {
        ...aaNode,
        reach: [1, 0.5, 0.25],
        marginal: [1, 0.5, 0.25],
      },
    });
    render(<ComboInspector />);
    const fills = [
      ...document.querySelectorAll('.hands-combo[data-present="true"]'),
    ].map((el) => Number((el as HTMLElement).style.getPropertyValue("--mass-fill")));
    expect(fills).toContain(1);
    expect(fills.some((value) => value > 0 && value < 1)).toBe(true);
  });

  it("shows 12 offsuit suit slots for an unpaired offsuit cell", () => {
    useStudyStore.setState({
      currentNode: {
        node_id: "p0",
        reach_defined: true,
        actions: ["Check", "Bet 50"],
        // AKo-style: two offsuit combos only
        combos: ["AcKd", "AsKh"],
        marginal: [1, 1],
        strategy: [
          [0.5, 0.5],
          [0.4, 0.6],
        ],
      },
      // AKo is row>col for A=0,K=1 → row 1 col 0 in RANKS A,K,Q...
      selectedCell: { row: 1, col: 0, text: "AKo" },
      nodeValues: null,
    });
    render(<ComboInspector />);
    expect(document.querySelectorAll(".hands-combo")).toHaveLength(12);
    expect(
      document.querySelectorAll('.hands-combo[data-present="true"]'),
    ).toHaveLength(2);
    expect(
      document.querySelector(".hands-combo-grid")?.getAttribute("data-shape"),
    ).toBe("offsuit");
  });
});
