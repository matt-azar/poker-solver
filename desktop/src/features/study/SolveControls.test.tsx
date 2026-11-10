import { cleanup, render, screen } from "@testing-library/react";
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

const pickOpenPath = vi.fn(async () => null as string | null);
const pickSavePath = vi.fn(async () => null as string | null);

vi.mock("../../platform/browser", () => ({
  getPlatform: () => ({
    kind: "browser" as const,
    pickOpenPath,
    pickSavePath,
    revealInFolder: async () => undefined,
  }),
}));

const { useStudyStore } = await import("../../state/studyStore");
const { SolveControls } = await import("./SolveControls");

describe("SolveControls open/save pickers (R14)", () => {
  beforeEach(() => {
    pickOpenPath.mockReset();
    pickSavePath.mockReset();
    pickOpenPath.mockResolvedValue(null);
    pickSavePath.mockResolvedValue(null);
    useStudyStore.setState({
      phase: "complete",
      solutionId: "sol-1",
      draft: { ...useStudyStore.getState().draft, solutionPath: "" },
      openSolution: vi.fn(async () => undefined),
      saveSolution: vi.fn(async () => undefined),
      updateDraft: vi.fn((partial) => {
        useStudyStore.setState({
          draft: { ...useStudyStore.getState().draft, ...partial },
        });
      }),
      solve: vi.fn(async () => undefined),
      continueSolve: vi.fn(async () => undefined),
      pause: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      calculateEv: vi.fn(async () => undefined),
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps Save and Open and drops the footer-duplicated solve buttons", () => {
    render(<SolveControls />);
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
    for (const name of ["Solve", "Continue", "Pause", "Stop", "EV"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("Open uses the platform picker and skips open on cancel", async () => {
    const user = userEvent.setup();
    render(<SolveControls />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(pickOpenPath).toHaveBeenCalled();
    expect(useStudyStore.getState().openSolution).not.toHaveBeenCalled();
  });

  it("Open loads the picked path", async () => {
    pickOpenPath.mockResolvedValueOnce("/tmp/from-toolbar.psol");
    const user = userEvent.setup();
    render(<SolveControls />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(useStudyStore.getState().openSolution).toHaveBeenCalledWith(
      "/tmp/from-toolbar.psol",
    );
  });

  it("Save prompts Save As when no path is set; cancel leaves study alone", async () => {
    const user = userEvent.setup();
    render(<SolveControls />);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(pickSavePath).toHaveBeenCalled();
    expect(useStudyStore.getState().saveSolution).not.toHaveBeenCalled();
  });

  it("Save reuses an existing path without prompting", async () => {
    useStudyStore.setState({
      draft: {
        ...useStudyStore.getState().draft,
        solutionPath: "/tmp/existing.psol",
      },
    });
    const user = userEvent.setup();
    render(<SolveControls />);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(pickSavePath).not.toHaveBeenCalled();
    expect(useStudyStore.getState().saveSolution).toHaveBeenCalled();
  });
});
