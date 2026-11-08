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

  it("toggles action filter on click without Open/follow controls", () => {
    render(<ActionSummary />);
    const b50Filter = screen.getByRole("button", {
      name: /Filter b50,\s*31\.9%/i,
    });
    expect(b50Filter.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(b50Filter);
    expect(useStudyStore.getState().actionFilter).toBe(1);
    expect(b50Filter.getAttribute("aria-pressed")).toBe("true");

    expect(screen.queryByRole("button", { name: /Follow /i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Open /i })).toBeNull();
    expect(screen.getByText("Filter")).toBeTruthy();
    expect(screen.queryByText("Filter · Open")).toBeNull();
    expect(followAction).not.toHaveBeenCalled();
  });

  it("shows a compact action-color legend with pot tags", () => {
    render(<ActionSummary />);
    const legend = screen.getByLabelText("Action color legend");
    expect(within(legend).getByText("Check")).toBeTruthy();
    expect(within(legend).getByText("b50")).toBeTruthy();
    expect(within(legend).getByText("b100")).toBeTruthy();
  });

  it("renders a panel Actions heading and frequency mix bar", () => {
    render(<ActionSummary />);
    expect(screen.getByRole("heading", { name: "Actions" })).toBeTruthy();
    expect(screen.getByLabelText("Action frequency mix")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Matrix mode" })).toBeNull();
  });

  it("paints the frequency mix bar aggressive-left", () => {
    render(<ActionSummary />);
    const mix = screen.getByLabelText("Action frequency mix");
    const segs = [...mix.querySelectorAll(".action-summary__mix-seg")] as HTMLElement[];
    expect(segs.length).toBe(3);
    // Bet 100, Bet 50, Check — same left-to-right order as the main matrix.
    expect(segs[0]?.style.background).toMatch(/196,\s*92,\s*58|#C45C3A/i);
    expect(segs[1]?.style.background).toMatch(/201,\s*132,\s*63|#C9843F/i);
    expect(segs[2]?.style.background).toMatch(/63,\s*143,\s*107|#3F8F6B/i);
  });

  it("reacts immediately when Settings betSizeDisplay changes", () => {
    const { rerender } = render(<ActionSummary />);
    expect(screen.getAllByText("b50").length).toBeGreaterThan(0);
    expect(screen.getAllByText("50.0 chips").length).toBeGreaterThan(0);

    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        betSizeDisplay: "chips",
      },
    });
    rerender(<ActionSummary />);
    expect(screen.queryByText("b50")).toBeNull();
    expect(screen.getAllByText("50.0 chips").length).toBeGreaterThan(0);

    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        betSizeDisplay: "pot",
      },
    });
    rerender(<ActionSummary />);
    expect(screen.getAllByText("b50").length).toBeGreaterThan(0);
    expect(screen.queryByText("50.0 chips")).toBeNull();
  });

  it("shows r-tags for engine Raise to labels using to_call basis", () => {
    useStudyStore.setState({
      currentNode: {
        node_id: "n-facing",
        kind: "decision",
        player: 1,
        pot: 200,
        to_call: 100,
        actions: ["Fold", "Call", "Raise to 400"],
        children: ["n-f", "n-c", "n-r"],
        combos: ["AsAh"],
        marginal: [1],
        reach_defined: true,
        strategy: [[0.1, 0.4, 0.5]],
      },
      status: {
        pot: 200,
        root_node_id: "n-facing",
      } as never,
    });
    render(<ActionSummary />);
    // basis = pot + to_call = 300; raise increment = 400 - 100 = 300 → r100
    expect(screen.getAllByText("r100").length).toBeGreaterThan(0);
    expect(screen.getByText("400.0 chips")).toBeTruthy();
    expect(screen.queryByText("Raise to 400")).toBeNull();
  });
});
