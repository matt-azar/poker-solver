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
      solutionId: null,
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
});
