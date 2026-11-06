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
const { LockDrawer } = await import("./LockDrawer");
const { nodeIndicesForCell } = await import("./LockPaintPanel");

const aaNode: NodePayload = {
  node_id: "p0",
  kind: "decision",
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

describe("LockPaintPanel", () => {
  beforeEach(() => {
    useStudyStore.setState({
      currentNode: aaNode,
      lockDraft: { kind: "selected", handIndices: [], probs: [0.5, 0.5] },
      lockDraftBaseline: null,
      lockDrawerOpen: true,
      locks: [],
      solutionId: "sol-test",
      phase: "idle",
      message: "",
      warmStart: false,
      baselineSolutionId: null,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("maps AA matrix cell to the node's AA combo indices", () => {
    expect(nodeIndicesForCell(aaNode.combos, 0, 0)).toEqual([0, 1, 2]);
  });

  it("paints a hand class into the lock draft from the Lock drawer", async () => {
    const user = userEvent.setup();
    render(<LockDrawer />);

    expect(screen.getByRole("grid", { name: "Paint lock hand classes" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "AA" }));

    expect(useStudyStore.getState().lockDraft.handIndices).toEqual([0, 1, 2]);
    expect(useStudyStore.getState().lockDraft.kind).toBe("selected");
  });

  it("toggles a painted class off on a second click", async () => {
    const user = userEvent.setup();
    useStudyStore.setState({
      lockDraft: { kind: "selected", handIndices: [0, 1, 2], probs: [0.5, 0.5] },
    });
    render(<LockDrawer />);

    await user.click(screen.getByRole("button", { name: "AA selected" }));
    expect(useStudyStore.getState().lockDraft.handIndices).toEqual([]);
  });

  it("hides the paint grid while Full node scope is active", async () => {
    const user = userEvent.setup();
    render(<LockDrawer />);
    await user.click(screen.getByRole("button", { name: "Full node" }));
    expect(screen.queryByRole("grid", { name: "Paint lock hand classes" })).toBeNull();
    expect(
      screen.getByText(/Switch to Selected combos to paint hand classes/),
    ).toBeTruthy();
  });
});
