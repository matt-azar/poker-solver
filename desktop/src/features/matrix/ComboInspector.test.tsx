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

describe("ComboInspector lock selection", () => {
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

  it("Lock selection uses checked combos, not the entire hand class", async () => {
    const user = userEvent.setup();
    render(<ComboInspector />);

    await user.click(screen.getByRole("checkbox", { name: "Select AhAd for lock" }));
    expect(useStudyStore.getState().lockDraft.handIndices).toEqual([0]);

    await user.click(screen.getByRole("button", { name: "Lock selection" }));

    const draft = useStudyStore.getState().lockDraft;
    expect(draft.handIndices).toEqual([0]);
    expect(useStudyStore.getState().lockDrawerOpen).toBe(true);
  });

  it("Lock entire hand class selects every combo in the focused class", async () => {
    const user = userEvent.setup();
    render(<ComboInspector />);

    await user.click(screen.getByRole("button", { name: "Lock entire hand class" }));

    expect(useStudyStore.getState().lockDraft.handIndices).toEqual([0, 1, 2]);
    expect(useStudyStore.getState().lockDrawerOpen).toBe(true);
  });

  it("disables Lock selection when nothing is checked", () => {
    render(<ComboInspector />);
    expect(
      (screen.getByRole("button", { name: "Lock selection" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("keeps lock/edit actions without duplicate editor entry points", async () => {
    const user = userEvent.setup();
    render(<ComboInspector />);

    expect(screen.getByRole("button", { name: "Lock selection" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Lock entire hand class" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit strategy" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Lock editor" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Strategy editor" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Lock" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Edit strategy" }));
    expect(useStudyStore.getState().strategyEditDrawerOpen).toBe(true);
    expect(useStudyStore.getState().strategyEditDraft.handIndices).toEqual([0, 1, 2]);
  });

  it("shows Hands empty hint when nothing is hovered or selected", () => {
    useStudyStore.setState({ selectedCell: null, hoverCell: null });
    render(<ComboInspector />);
    expect(screen.getByRole("heading", { name: "Hands" })).toBeTruthy();
    expect(screen.getByText("Hover a hand in the grid.")).toBeTruthy();
  });

  it("lists strategy bars and per-action EV across the pair suit grid", () => {
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
      document.querySelectorAll('.hands-combo[data-present="true"] .hands-combo__mix i')
        .length,
    ).toBeGreaterThan(0);
  });

  it("shows 16 offsuit suit slots for an unpaired offsuit cell", () => {
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
    expect(document.querySelectorAll(".hands-combo")).toHaveLength(16);
    expect(
      document.querySelectorAll('.hands-combo[data-present="true"]'),
    ).toHaveLength(2);
    expect(
      document.querySelector(".hands-combo-grid")?.getAttribute("data-shape"),
    ).toBe("offsuit");
  });
});
