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

vi.mock("../../state/solutionsCatalogueUi", () => ({
  useSolutionsCatalogueUi: (
    selector: (state: {
      openCatalogue: (mode: "open" | "save") => void;
    }) => unknown,
  ) =>
    selector({
      openCatalogue: vi.fn(),
    }),
}));

const { useStudyStore } = await import("../../state/studyStore");
const { StartupEmptyState } = await import("./StartupEmptyState");

describe("StartupEmptyState", () => {
  beforeEach(() => {
    useStudyStore.setState({
      connection: "connected",
      solutionId: null,
      phase: "idle",
      workspace: "study",
      libraryLists: {
        recent: [
          { path: "/tmp/a.psol", name: "River SRP", mtime: 0 },
        ],
        templates: [],
        ranges: [],
        loading: false,
      },
      loadRecent: vi.fn(async () => undefined),
      openSolution: vi.fn(async () => ({ ok: true as const, path: "/tmp/a.psol" })),
      setWorkspace: vi.fn(),
      updateDraft: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("offers New, Open, and recent only", async () => {
    const user = userEvent.setup();
    render(<StartupEmptyState />);
    expect(screen.getByRole("button", { name: "New solution" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open solution" })).toBeTruthy();
    expect(screen.getByText("River SRP")).toBeTruthy();
    expect(screen.queryByText("No actions at this node")).toBeNull();
    await user.click(screen.getByRole("button", { name: "New solution" }));
    expect(useStudyStore.getState().setWorkspace).toHaveBeenCalledWith("build");
  });
});
