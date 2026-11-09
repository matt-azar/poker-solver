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
    planMemory: vi.fn(),
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

  afterEach(() => {
    cleanup();
  });

  it("previews with the same buildJob body Solve uses", async () => {
    render(<TreeLineEditor />);
    await waitFor(() => expect(treePreview).toHaveBeenCalled());
    const body = treePreview.mock.calls[0]?.[0];
    expect(body).toEqual(buildJob(useStudyStore.getState().draft));
    expect(await screen.findByText("Check")).toBeTruthy();
    expect(screen.getByText(/Plan peak/i)).toBeTruthy();
    expect(screen.getByText(/2\.0 MiB/)).toBeTruthy();
  });

  it("writes Force edits into the draft consumed by Solve", async () => {
    const user = userEvent.setup();
    render(<TreeLineEditor />);
    await screen.findByText("Check");
    await user.click(screen.getAllByRole("button", { name: "Force" })[0]!);
    expect(useStudyStore.getState().draft.treeEdits).toContain("force - c");
  });

  it("clears a stale preview when the draft changes", async () => {
    render(<TreeLineEditor />);
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
