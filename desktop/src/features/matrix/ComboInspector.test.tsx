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

const { useMatrixDisplayStore } = await import("../../domain/matrixDisplay");
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
    localStorage.clear();
    useMatrixDisplayStore.getState().resetPrefs();
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
      status: { pot: 100 },
      draft: { ...useStudyStore.getState().draft, pot: 100 },
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

  it("renders GTOWizard-style badge, black metrics, and passive-left paint", () => {
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
    useMatrixDisplayStore.getState().setCellOverlay("ev");
    render(<ComboInspector />);
    expect(document.querySelectorAll(".hands-combo")).toHaveLength(6);
    expect(
      document.querySelectorAll('.hands-combo[data-present="true"]'),
    ).toHaveLength(3);
    expect(document.querySelector(".hands-combo__badge")).toBeTruthy();
    expect(document.querySelector(".hands-combo__badge-suit")?.textContent).toMatch(
      /[♠♥♦♣]/,
    );
    // Four-color deck: each badge card carries data-suit (never red/black pairs).
    const badgeCards = [
      ...document.querySelectorAll(".hands-combo__badge-card"),
    ] as HTMLElement[];
    expect(badgeCards.length).toBeGreaterThan(0);
    for (const card of badgeCards) {
      expect(card.getAttribute("data-suit")).toMatch(/^[cdhs]$/);
      expect(card.hasAttribute("data-red")).toBe(false);
    }
    expect(screen.getByText("0.5")).toBeTruthy();
    expect(screen.getByText("2.5")).toBeTruthy();
    const present = document.querySelector(
      '.hands-combo[data-present="true"]',
    ) as HTMLElement;
    const segs = [
      ...present.querySelectorAll(".hands-combo__weight-fill .strategy-paint__seg"),
    ] as HTMLElement[];
    expect(segs.length).toBeGreaterThan(0);
    // Check (passive) is left-most; Bet (aggressive) is right (#C9843F → rgb).
    expect(segs[0]?.style.background).not.toMatch(/201,\s*132,\s*63|#C9843F/i);
    expect(segs[segs.length - 1]?.style.background).toMatch(
      /201,\s*132,\s*63|#C9843F/i,
    );
    expect(Number(segs[0]?.style.flexGrow)).toBeGreaterThan(0);
    // Metrics stay bottom-locked overlay — not painted onto segments.
    expect(present.querySelector(".hands-combo__body .hands-combo__metrics")).toBeTruthy();
    expect(present.querySelector(".hands-combo__metric-action")?.textContent).toMatch(
      /b50|Bet/i,
    );
  });

  it("sets --weight-fill from combo reach (paint height ∝ weight)", () => {
    useStudyStore.setState({
      currentNode: {
        ...aaNode,
        reach: [1, 0.5, 0.25],
        marginal: [1, 0.5, 0.25],
      },
    });
    render(<ComboInspector />);
    const present = [
      ...document.querySelectorAll('.hands-combo[data-present="true"]'),
    ] as HTMLElement[];
    const fills = present.map((el) =>
      Number(el.style.getPropertyValue("--weight-fill")),
    );
    expect(fills).toContain(1);
    expect(fills).toContain(0.5);
    expect(fills).toContain(0.25);
    expect(
      present.every((el) => el.getAttribute("data-weight-fill") === "true"),
    ).toBe(true);
  });

  it("flop unit-weight reach fills combo height; 1/n deal mass stays flat (ZR-121)", () => {
    useMatrixDisplayStore.getState().setRangeWeightHeightFill(true);
    useStudyStore.setState({
      selectedCell: { row: 0, col: 0, text: "AA" },
      currentNode: {
        node_id: "p0.t-1.r-1",
        kind: "decision",
        reach_defined: true,
        actions: ["Check", "Bet 50"],
        combos: ["AsAc", "AsAd", "AsAh"],
        reach: [1, 1, 1],
        marginal: [1 / 3, 1 / 3, 1 / 3],
        strategy: [
          [0.6, 0.4],
          [0.6, 0.4],
          [0.6, 0.4],
        ],
      },
    });
    const { unmount } = render(<ComboInspector />);
    const full = [
      ...document.querySelectorAll('.hands-combo[data-present="true"]'),
    ] as HTMLElement[];
    expect(full.length).toBeGreaterThan(0);
    expect(
      full.every(
        (el) => Number(el.style.getPropertyValue("--weight-fill")) === 1,
      ),
    ).toBe(true);
    unmount();

    useStudyStore.setState({
      selectedCell: { row: 0, col: 0, text: "AA" },
      currentNode: {
        node_id: "p0.t-1.r-1",
        kind: "decision",
        reach_defined: true,
        actions: ["Check", "Bet 50"],
        combos: ["AsAc", "AsAd", "AsAh"],
        reach: [1 / 3, 1 / 3, 1 / 3],
        marginal: [1 / 3, 1 / 3, 1 / 3],
        strategy: [
          [0.6, 0.4],
          [0.6, 0.4],
          [0.6, 0.4],
        ],
      },
    });
    render(<ComboInspector />);
    const flat = [
      ...document.querySelectorAll('.hands-combo[data-present="true"]'),
    ] as HTMLElement[];
    expect(flat.length).toBeGreaterThan(0);
    expect(
      flat.every(
        (el) => Number(el.style.getPropertyValue("--weight-fill")) < 0.4,
      ),
    ).toBe(true);
  });

  it("shows 12 offsuit suit slots for an unpaired offsuit cell", () => {
    useStudyStore.setState({
      currentNode: {
        node_id: "p0",
        reach_defined: true,
        actions: ["Check", "Bet 50"],
        combos: ["AcKd", "AsKh"],
        marginal: [1, 1],
        strategy: [
          [0.5, 0.5],
          [0.4, 0.6],
        ],
      },
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

  it("uses vertical bands by width and sets data-shape for 4/6/12 grids", () => {
    render(<ComboInspector />);
    expect(
      document.querySelector(".hands-combo-grid")?.getAttribute("data-shape"),
    ).toBe("pair");
    const segs = [
      ...document.querySelectorAll(
        '.hands-combo[data-present="true"] .strategy-paint__seg',
      ),
    ] as HTMLElement[];
    expect(segs.length).toBeGreaterThan(0);
    expect(segs.every((seg) => Number(seg.style.flexGrow) > 0)).toBe(true);
    cleanup();

    useStudyStore.setState({
      currentNode: {
        node_id: "p0",
        reach_defined: true,
        actions: ["Check", "Bet 50"],
        combos: ["AsKs", "AhKh"],
        marginal: [1, 1],
        strategy: [
          [0.5, 0.5],
          [0.4, 0.6],
        ],
      },
      selectedCell: { row: 0, col: 1, text: "AKs" },
      nodeValues: null,
    });
    render(<ComboInspector />);
    expect(
      document.querySelector(".hands-combo-grid")?.getAttribute("data-shape"),
    ).toBe("suited");
    expect(document.querySelectorAll(".hands-combo")).toHaveLength(4);
  });

  it("gives wider vertical bands to higher-frequency actions", () => {
    useStudyStore.setState({
      currentNode: {
        node_id: "p0",
        reach_defined: true,
        actions: ["Check", "Bet 50"],
        combos: ["AhAd"],
        marginal: [1],
        strategy: [[0.25, 0.75]],
      },
      selectedCell: { row: 0, col: 0, text: "AA" },
      nodeValues: null,
    });
    render(<ComboInspector />);
    const segs = [
      ...document.querySelectorAll(
        '.hands-combo[data-present="true"] .strategy-paint__seg',
      ),
    ] as HTMLElement[];
    // Passive left: Check (0.25) then Bet (0.75).
    expect(segs).toHaveLength(2);
    expect(Number(segs[0]?.style.flexGrow)).toBeCloseTo(0.25);
    expect(Number(segs[1]?.style.flexGrow)).toBeCloseTo(0.75);
    // Text list stays in the body overlay, not inside segments.
    expect(
      document.querySelectorAll(
        ".hands-combo__body .hands-combo__metric-row:not(.hands-combo__metric-row--eq)",
      ),
    ).toHaveLength(2);
  });

  it("shows check-down equity in Hands when equity overlay is on", () => {
    useStudyStore.setState({
      currentNode: {
        ...aaNode,
        player: 0,
      },
      equity: {
        pending: false,
        node_id: "p0",
        oop_hands: [
          { combo: "AhAd", equity: 0.82, weight: 1 },
          { combo: "AhAs", equity: 0.71, weight: 1 },
          { combo: "AhAc", equity: 0.64, weight: 1 },
        ],
        ip_hands: [],
      },
    });
    useMatrixDisplayStore.getState().setCellOverlay("equity");
    render(<ComboInspector />);
    const eqRows = document.querySelectorAll(".hands-combo__metric-row--eq");
    expect(eqRows.length).toBeGreaterThan(0);
    expect(screen.getByText("82.0")).toBeTruthy();
    expect(screen.getByText("71.0")).toBeTruthy();
    expect(screen.getByText("64.0")).toBeTruthy();
    // Action metrics stay on frequency when overlay is equity-only.
    expect(screen.getAllByText("Freq").length).toBeGreaterThan(0);
  });
});
