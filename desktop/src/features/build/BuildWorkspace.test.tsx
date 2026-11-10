import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../../domain/profiles", async () => {
  const actual = await vi.importActual<typeof import("../../domain/profiles")>(
    "../../domain/profiles",
  );
  const memory = new Map<string, string>();
  const storage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value);
    },
  };
  let catalogue = actual.createSeatActionCatalogue([], storage);
  return {
    ...actual,
    loadBundledSeatActions: () => [],
    getSeatActionCatalogue: () => catalogue,
    resetSeatActionCatalogueForTests: () => {
      memory.clear();
      catalogue = actual.createSeatActionCatalogue([], storage);
    },
  };
});

vi.mock("../../engine/client", () => ({
  EngineError: class EngineError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.status = status;
    }
  },
  engineClient: {
    treePreview: vi.fn(async () => ({
      nodes: [],
      tree_edits: [],
      plan: {
        estimated_peak_bytes: 1024,
        memory_budget_bytes: 1024 * 1024,
        deals: 0,
        infosets: 0,
        decision_nodes: 0,
        terminals: 0,
        public_decisions: 0,
        threads: 1,
        fits_budget: true,
        dry_run: true,
      },
    })),
  },
}));

const { resetSeatActionCatalogueForTests } = await import("../../domain/profiles");
const { useStudyStore } = await import("../../state/studyStore");
const { BuildWorkspace, formatPaintCellWeight } = await import("./BuildWorkspace");

describe("formatPaintCellWeight", () => {
  it("shows two decimals only for weights strictly between 0 and 1", () => {
    expect(formatPaintCellWeight(0)).toBeNull();
    expect(formatPaintCellWeight(1)).toBeNull();
    expect(formatPaintCellWeight(0.4)).toBe("0.40");
    expect(formatPaintCellWeight(0.01)).toBe("0.01");
    expect(formatPaintCellWeight(0.75)).toBe("0.75");
  });
});

describe("BuildWorkspace range tools", () => {
  beforeEach(() => {
    resetSeatActionCatalogueForTests();
    useStudyStore.setState({
      draft: {
        ...useStudyStore.getState().draft,
        oopRange: "AA,KK",
        ipRange: "QQ+",
        pot: 10,
        stack: 100,
        boardText: "Ah Kd 2c",
      },
      weights: {
        oop: useStudyStore.getState().weights.oop,
        ip: useStudyStore.getState().weights.ip,
      },
      paintWeight: 0.4,
      canUndoRange: false,
      canRedoRange: false,
      solveValidationErrors: [],
      phase: "idle",
      workspace: "build",
    });
    useStudyStore.getState().setRangeText("oop", "AA,KK");
    useStudyStore.getState().setRangeText("ip", "QQ+");
  });

  afterEach(() => {
    cleanup();
  });

  it("starts with Preview tree collapsed and omits removed Build chrome", () => {
    render(<BuildWorkspace />);
    const preview = screen.getByRole("button", { name: "Preview tree" });
    expect(preview.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("heading", { name: "Spot" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Solve & open Study" })).toBeNull();
    expect(screen.queryByText("Flop donk")).toBeNull();
    expect(screen.queryByText(/Blank bet = check only/)).toBeNull();
    expect(screen.getByLabelText(/Flop OOP bets/).getAttribute("placeholder")).toBeNull();
    expect(screen.getByLabelText(/Turn donk/).getAttribute("placeholder")).toBeNull();
    expect(screen.getByRole("button", { name: "Save tree" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open tree" })).toBeTruthy();
  });

  it("opens a saved betting tree into sizes and edits without touching board or ranges", async () => {
    const user = userEvent.setup();
    useStudyStore.setState({
      draft: {
        ...useStudyStore.getState().draft,
        boardText: "Ah Kd 2c",
        oopRange: "AA,KK",
        ipRange: "QQ+",
        oopFlop: "25",
        treeEdits: [],
      },
    });
    render(<BuildWorkspace />);
    const file = new File(
      [
        JSON.stringify({
          format: "holdem-study-betting-tree",
          version: 1,
          name: "test tree",
          tree: {
            oopFlop: "33, 75",
            ipFlop: "50",
            potCap: 3,
            treeEdits: ["force - c"],
          },
        }),
      ],
      "tree.json",
      { type: "application/json" },
    );
    await user.upload(screen.getByLabelText("Open betting tree file"), file);
    const draft = useStudyStore.getState().draft;
    expect(draft.oopFlop).toBe("33, 75");
    expect(draft.ipFlop).toBe("50");
    expect(draft.potCap).toBe(3);
    expect(draft.treeEdits).toEqual(["force - c"]);
    expect(draft.boardText).toBe("Ah Kd 2c");
    expect(draft.oopRange).toBe("AA,KK");
    expect(draft.ipRange).toBe("QQ+");
  });

  it("lets the user type a paint weight into a number field", async () => {
    const user = userEvent.setup();
    render(<BuildWorkspace />);
    const input = screen.getByLabelText("Paint weight value") as HTMLInputElement;
    expect(input.value).toBe("0.40");
    await user.clear(input);
    await user.type(input, "0.75");
    await user.tab();
    expect(useStudyStore.getState().paintWeight).toBeCloseTo(0.75, 5);
    expect(input.value).toBe("0.75");
  });

  it("shows cell weights under hand ids only for fractional weights", () => {
    useStudyStore.getState().setPaintWeight(0.4);
    useStudyStore.getState().setRangeText("oop", "AA,KK:0.5");
    render(<BuildWorkspace />);
    const oopGrid = screen.getByRole("grid", { name: "oop range" });
    const aa = oopGrid.querySelector('[data-row="0"][data-col="0"]');
    const kk = oopGrid.querySelector('[data-row="1"][data-col="1"]');
    const ak = oopGrid.querySelector('[data-row="0"][data-col="1"]');
    expect(aa?.querySelector(".paint-cell__hand")?.textContent).toBe("AA");
    expect(aa?.querySelector(".paint-cell__weight")).toBeNull();
    expect(kk?.querySelector(".paint-cell__hand")?.textContent).toBe("KK");
    expect(kk?.querySelector(".paint-cell__weight")?.textContent).toBe("0.50");
    expect(ak?.querySelector(".paint-cell__weight")).toBeNull();
  });

  it("swaps OOP and IP range text without flipping layout labels", async () => {
    const user = userEvent.setup();
    render(<BuildWorkspace />);
    expect(screen.getByRole("heading", { name: "OOP" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "IP" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Swap" }));
    expect(useStudyStore.getState().draft.oopRange).toBe("QQ+");
    expect(useStudyStore.getState().draft.ipRange).toBe("AA,KK");
    expect(screen.getByRole("heading", { name: "OOP" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "IP" })).toBeTruthy();
  });

  it("saves the current seat range into the catalogue and can edit it", async () => {
    const user = userEvent.setup();
    render(<BuildWorkspace />);
    await user.click(screen.getAllByRole("button", { name: "Catalogue" })[0]!);
    expect(screen.getByRole("heading", { name: "Unfiled saves" })).toBeTruthy();
    const nameField = screen.getByLabelText(
      "Name for unfiled OOP range",
    ) as HTMLInputElement;
    fireEvent.change(nameField, { target: { value: "My BTN open" } });
    expect(nameField.value).toBe("My BTN open");
    await user.click(screen.getByRole("button", { name: "Save unfiled" }));
    expect(screen.getByRole("button", { name: "My BTN open" })).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: "Actions for My BTN open" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Saved range name"), {
      target: { value: "Renamed open" },
    });
    fireEvent.change(screen.getByLabelText("Saved range text"), {
      target: { value: "AKs,AA" },
    });
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByRole("button", { name: "Renamed open" })).toBeTruthy();

    useStudyStore.getState().setRangeText("oop", "22");
    await user.click(screen.getByRole("button", { name: "Renamed open" }));
    expect(useStudyStore.getState().draft.oopRange).toBe("AKs,AA");
  });
});
