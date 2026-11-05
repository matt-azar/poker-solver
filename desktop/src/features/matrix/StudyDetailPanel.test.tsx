import { cleanup, render, screen } from "@testing-library/react";
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
const { StudyDetailPanel } = await import("./StudyDetailPanel");

const node: NodePayload = {
  node_id: "n1",
  kind: "decision",
  player: 0,
  pot: 100,
  actions: ["Check", "Bet 50"],
  children: ["n-check", "n-b50"],
  combos: ["AhAd", "AhAs"],
  marginal: [1, 1],
  reach_defined: true,
  strategy: [
    [0.4, 0.6],
    [0.5, 0.5],
  ],
};

describe("StudyDetailPanel", () => {
  beforeEach(() => {
    useStudyStore.setState({
      currentNode: node,
      status: { pot: 100, root_node_id: "n1" } as never,
      draft: { ...useStudyStore.getState().draft, pot: 100 },
      actionFilter: null,
      selectedCell: null,
      hoverCell: null,
      nodeValues: null,
      lockDraft: { kind: "selected", handIndices: [], probs: [0.5, 0.5] },
      locks: [],
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("shows Actions even when no hand is hovered", () => {
    render(<StudyDetailPanel />);
    expect(screen.getByRole("region", { name: "Actions" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Actions" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Filter/i }).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Action frequency mix")).toBeTruthy();
  });

  it("Hands shows empty hint until a cell is focused", () => {
    render(<StudyDetailPanel />);
    expect(screen.getByRole("region", { name: "Hands" })).toBeTruthy();
    expect(screen.getByText("Hover a hand in the grid.")).toBeTruthy();
  });

  it("Hands lists suit slots for a hovered hand class", () => {
    useStudyStore.setState({
      hoverCell: { row: 0, col: 0, text: "AA" },
    });
    render(<StudyDetailPanel />);
    // Pair cells show 6 suit-pair slots; labels are suit symbols with combo in title.
    expect(document.querySelectorAll(".hands-combo")).toHaveLength(6);
    expect(document.querySelector('[title="AhAd"]')).toBeTruthy();
    expect(document.querySelector('[title="AsAh"]')).toBeTruthy();
    expect(screen.queryByText("Hover a hand in the grid.")).toBeNull();
  });
});
