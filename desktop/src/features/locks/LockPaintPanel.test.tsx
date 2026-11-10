import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("Node Locking workspace", () => {
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

  it("opens as a dedicated Node Locking dialog", () => {
    render(<LockDrawer />);
    expect(screen.getByRole("dialog", { name: "Node locking" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save & Close" })).toBeTruthy();
    expect(screen.getByRole("grid", { name: "Paint lock hand classes" })).toBeTruthy();
  });

  it("paints a hand class into the lock draft from the workspace", async () => {
    const user = userEvent.setup();
    render(<LockDrawer />);

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

  it("links frequency sliders so action probs stay normalized", async () => {
    const user = userEvent.setup();
    render(<LockDrawer />);
    const slider = screen.getByRole("slider", { name: "Check frequency" });
    await user.click(slider);
    // Direct store path covers linked redistribution used by the slider.
    useStudyStore.getState().setLockProbLinked(0, 0.8);
    const probs = useStudyStore.getState().lockDraft.probs;
    expect(probs[0]).toBeCloseTo(0.8, 12);
    expect(probs[1]).toBeCloseTo(0.2, 12);
  });

  it("closes after a successful Save & Close", async () => {
    const user = userEvent.setup();
    const applyLock = vi.fn(async () => true);
    useStudyStore.setState({
      lockDraft: { kind: "selected", handIndices: [0, 1, 2], probs: [0.5, 0.5] },
      applyLock,
    });
    render(<LockDrawer />);
    await user.click(screen.getByRole("button", { name: "Save & Close" }));
    expect(applyLock).toHaveBeenCalled();
    expect(useStudyStore.getState().lockDrawerOpen).toBe(false);
  });

  it("selects every combo with Select all", async () => {
    const user = userEvent.setup();
    render(<LockDrawer />);
    await user.click(screen.getByRole("button", { name: "Select all" }));
    expect(useStudyStore.getState().lockDraft.handIndices).toEqual([0, 1, 2]);
  });

  it("paints strategy segments passive-left in cells and overall bar", () => {
    useStudyStore.setState({
      currentNode: {
        ...aaNode,
        actions: ["Check", "Bet 50", "Bet 100"],
        strategy: [
          [0.2, 0.3, 0.5],
          [0.2, 0.3, 0.5],
          [0.2, 0.3, 0.5],
        ],
      },
      lockDraft: { kind: "selected", handIndices: [], probs: [0.2, 0.3, 0.5] },
    });
    render(<LockDrawer />);

    const aa = screen.getByRole("button", { name: "AA" });
    const cellSegs = [
      ...aa.querySelectorAll(".lock-paint-cell__seg"),
    ] as HTMLElement[];
    expect(cellSegs.length).toBe(3);
    // Check (passive) left, then Bet 50, then Bet 100.
    expect(cellSegs[0]?.style.background).toMatch(/63,\s*143,\s*107|#3F8F6B/i);
    expect(cellSegs[1]?.style.background).toMatch(/201,\s*132,\s*63|#C9843F/i);
    expect(cellSegs[2]?.style.background).toMatch(/196,\s*92,\s*58|#C45C3A/i);

    const overall = screen.getByLabelText("Overall range");
    const barSegs = [
      ...overall.querySelectorAll(".node-lock-bar__seg"),
    ] as HTMLElement[];
    expect(barSegs.length).toBe(3);
    expect(barSegs[0]?.style.background).toMatch(/63,\s*143,\s*107|#3F8F6B/i);
    expect(barSegs[2]?.style.background).toMatch(/196,\s*92,\s*58|#C45C3A/i);
    expect(overall.querySelector(".node-lock-bar__legend")?.textContent).toMatch(
      /^Check .* · Bet 50 .* · Bet 100 /,
    );
  });
});
