import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

const treePreview = vi.fn();

vi.mock("../../engine/client", () => ({
  EngineError: class EngineError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.status = status;
    }
  },
  engineClient: {
    treePreview: (...args: unknown[]) => treePreview(...args),
  },
}));

const { useStudyStore } = await import("../../state/studyStore");
const { TreeLineEditor } = await import("./TreeLineEditor");
const { buildJob } = await import("../../state/studyDraft");

describe("TreeLineEditor", () => {
  beforeEach(() => {
    treePreview.mockReset();
    treePreview.mockResolvedValue({
      nodes: [
        {
          index: 0,
          terminal: false,
          chance: false,
          player: 0,
          street: 0,
          path: "",
          chance_child: -1,
          actions: [
            { label: "Check", compact: "c", child_index: 1 },
            { label: "Bet 50", compact: "b50", child_index: 2 },
          ],
          children: [1, 2],
        },
        {
          index: 2,
          terminal: false,
          chance: false,
          player: 1,
          street: 0,
          path: "Bet 50",
          chance_child: -1,
          actions: [
            { label: "Fold", compact: "f", child_index: 3 },
            { label: "Call", compact: "call", child_index: 4 },
            { label: "Raise to 150", compact: "r150", child_index: 5 },
          ],
          children: [3, 4, 5],
        },
      ],
      tree_edits: [],
      plan: {
        estimated_peak_bytes: 2_097_152,
        memory_budget_bytes: 67_108_864,
        deals: 48,
        infosets: 10,
        decision_nodes: 20,
        terminals: 30,
        public_decisions: 4,
        threads: 1,
        fits_budget: true,
        dry_run: true,
      },
    });
    useStudyStore.setState({
      phase: "idle",
      draft: {
        ...useStudyStore.getState().draft,
        boardText: "Ah Kd 7c 2s",
        oopRange: "AA",
        ipRange: "KK",
        pot: 100,
        stack: 200,
        oopTurn: "50",
        ipTurn: "50",
        treeEdits: [],
        memoryMib: 64,
      },
    });
  });

  it("does not issue tree_preview while Solve is running (ZR-158)", async () => {
    useStudyStore.setState({ phase: "solving" });
    render(<TreeLineEditor />);
    await new Promise((r) => setTimeout(r, 500));
    expect(treePreview).not.toHaveBeenCalled();
  });

  afterEach(() => {
    cleanup();
  });

  async function expandPreview() {
    const user = userEvent.setup();
    const toggle = screen.getByRole("button", { name: "Preview tree" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(toggle);
    return user;
  }

  it("previews with the same buildJob body Solve uses", async () => {
    render(<TreeLineEditor />);
    await waitFor(() => expect(treePreview).toHaveBeenCalled());
    const body = treePreview.mock.calls[0]?.[0];
    expect(body).toEqual(buildJob(useStudyStore.getState().draft));
    expect(screen.queryByText("Check")).toBeNull();
    // Plan memory sits above Preview tree even while collapsed.
    expect(screen.getByText(/Plan peak/i)).toBeTruthy();
    expect(screen.getByText(/2\.0 MiB/)).toBeTruthy();
    await expandPreview();
    expect(await screen.findByText("Check")).toBeTruthy();
    // Bet 50 into pot 100 → b50 (pot-%), not a chip+tag mashup.
    expect(screen.getByText("b50")).toBeTruthy();
    expect(screen.queryByText(/Bet 50/)).toBeNull();
  });

  it("reveals Force / Remove only after clicking a node", async () => {
    render(<TreeLineEditor />);
    const user = await expandPreview();
    await screen.findByText("Check");
    expect(screen.queryByRole("button", { name: "Force" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Check" }));
    expect(screen.getByRole("button", { name: "Force" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Force" }));
    expect(useStudyStore.getState().draft.treeEdits).toContain("force - c");
  });

  it("tags nested raises as pot percent of pot-before-bet", async () => {
    render(<TreeLineEditor />);
    await expandPreview();
    // After Bet 50 into 100, pot=150 facing=50; Raise to 150 → raise-by 100 → r67
    // (100/150). sizePot for raise tags is pot+call = 200 → r50.
    expect(await screen.findByText("r50")).toBeTruthy();
  });

  it("clears a stale preview when the draft changes", async () => {
    render(<TreeLineEditor />);
    await expandPreview();
    await screen.findByText("Check");
    treePreview.mockClear();
    treePreview.mockImplementation(
      () =>
        new Promise((resolve) => {
          window.setTimeout(
            () =>
              resolve({
                nodes: [],
                tree_edits: [],
                plan: {
                  estimated_peak_bytes: 1,
                  memory_budget_bytes: 1,
                  deals: 0,
                  infosets: 0,
                  decision_nodes: 0,
                  terminals: 0,
                  public_decisions: 0,
                  threads: 1,
                  fits_budget: true,
                  dry_run: true,
                },
              }),
            50,
          );
        }),
    );
    useStudyStore.getState().updateDraft({ oopTurn: "75" });
    await waitFor(() => {
      expect(screen.queryByText("Check")).toBeNull();
    });
  });
});
