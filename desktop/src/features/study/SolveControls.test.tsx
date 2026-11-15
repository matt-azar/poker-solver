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

const openCatalogue = vi.fn();

vi.mock("../../state/solutionsCatalogueUi", () => ({
  useSolutionsCatalogueUi: (
    selector: (state: {
      openCatalogue: typeof openCatalogue;
      closeCatalogue: () => void;
      mode: null;
    }) => unknown,
  ) =>
    selector({
      openCatalogue,
      closeCatalogue: () => undefined,
      mode: null,
    }),
}));

const { useStudyStore } = await import("../../state/studyStore");
const { SolveControls } = await import("./SolveControls");

describe("SolveControls open/save catalogue (in-app)", () => {
  beforeEach(() => {
    openCatalogue.mockReset();
    useStudyStore.setState({
      phase: "complete",
      solutionId: "sol-1",
      draft: { ...useStudyStore.getState().draft, solutionPath: "" },
      openSolution: vi.fn(async () => undefined),
      saveSolution: vi.fn(async (path: string) => ({ ok: true as const, path })),
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

  it("Open opens the in-app catalogue (not an OS picker)", async () => {
    const user = userEvent.setup();
    render(<SolveControls />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(openCatalogue).toHaveBeenCalledWith("open");
    expect(useStudyStore.getState().openSolution).not.toHaveBeenCalled();
  });

  it("Save without a path opens the catalogue save mode", async () => {
    const user = userEvent.setup();
    render(<SolveControls />);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(openCatalogue).toHaveBeenCalledWith("save");
    expect(useStudyStore.getState().saveSolution).not.toHaveBeenCalled();
  });

  it("Save reuses an existing path without opening the catalogue", async () => {
    useStudyStore.setState({
      draft: {
        ...useStudyStore.getState().draft,
        solutionPath: "/tmp/existing.psol",
      },
    });
    const user = userEvent.setup();
    render(<SolveControls />);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(openCatalogue).not.toHaveBeenCalled();
    expect(useStudyStore.getState().saveSolution).toHaveBeenCalledWith(
      "/tmp/existing.psol",
    );
  });
});
