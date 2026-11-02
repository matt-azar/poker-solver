import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

const { useSettingsStore } = await import("../../state/settingsStore");
const { useStudyStore } = await import("../../state/studyStore");
const { ActionSummary } = await import("./ActionSummary");

const followAction = vi.fn(async () => undefined);

function seedNode() {
  const node: NodePayload = {
    node_id: "n1",
    kind: "decision",
    player: 0,
    pot: 100,
    actions: ["Check", "Bet 50", "Bet 100"],
    children: ["n-check", "n-b50", "n-b100"],
    combos: ["AsAh", "KsKh"],
    marginal: [1, 1],
    reach_defined: true,
    strategy: [
      [0.2, 0.319, 0.481],
      [0.2, 0.319, 0.481],
    ],
  };
  useStudyStore.setState({
    currentNode: node,
    status: {
      pot: 100,
      root_node_id: "n1",
    } as never,
    draft: { ...useStudyStore.getState().draft, pot: 100 },
    actionFilter: null,
    matrixMode: "strategy",
    nodeValues: null,
    followAction,
  });
  useSettingsStore.setState({
    settings: {
      ...useSettingsStore.getState().settings,
      betSizeDisplay: "both",
    },
  });
}

describe("ActionSummary", () => {
  beforeEach(() => {
    followAction.mockClear();
    seedNode();
  });

  afterEach(() => {
    cleanup();
  });

  it("labels a 50% pot bet as b50 with separate frequency text", () => {
    render(<ActionSummary />);
    const filters = screen.getAllByRole("button", { name: /Filter/i });
    const b50 = filters.find((btn) => btn.getAttribute("aria-label")?.includes("b50"));
    expect(b50).toBeTruthy();
    expect(within(b50!).getByText("b50")).toBeTruthy();
    expect(within(b50!).getByText("50.0 chips")).toBeTruthy();
    expect(within(b50!).getByText("31.9%")).toBeTruthy();
    expect(b50!.textContent).not.toContain("Bet 50%");
    // Primary pot tag must not read as the frequency string.
    expect(within(b50!).queryByText("50%")).toBeNull();
  });

  it("distinguishes filter toggle from Open (follow) controls", () => {
    render(<ActionSummary />);
    const b50Filter = screen.getByRole("button", {
      name: /Filter b50,\s*31\.9%/i,
    });
    expect(b50Filter.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(b50Filter);
    expect(useStudyStore.getState().actionFilter).toBe(1);
    expect(b50Filter.getAttribute("aria-pressed")).toBe("true");

    const openB50 = screen.getByRole("button", { name: "Follow b50" });
    fireEvent.click(openB50);
    expect(followAction).toHaveBeenCalledWith("n-b50");
  });

  it("shows a compact action-color legend with pot tags", () => {
    render(<ActionSummary />);
    const legend = screen.getByLabelText("Action color legend");
    expect(within(legend).getByText("Check")).toBeTruthy();
    expect(within(legend).getByText("b50")).toBeTruthy();
    expect(within(legend).getByText("b100")).toBeTruthy();
  });
});
