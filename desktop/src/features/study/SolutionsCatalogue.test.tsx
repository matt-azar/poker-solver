import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetSolutionsCatalogueForTests,
  SOLUTIONS_CATALOGUE_STORAGE_KEY,
} from "../../domain/solutionsCatalogue";

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

vi.mock("../../domain/solutionsRoot", () => ({
  resolveCatalogueSavePath: vi.fn(async (folder: string, name: string) => ({
    ok: true as const,
    relativeKey: folder ? `${folder}/${name}.psol` : `${name}.psol`,
    path: folder
      ? `/tmp/holdem-study-solutions/${folder}/${name}.psol`
      : `/tmp/holdem-study-solutions/${name}.psol`,
  })),
  getSolutionsRoot: vi.fn(async () => "/tmp/holdem-study-solutions"),
  ensureSolutionsParent: vi.fn(async () => ({ ok: true as const })),
}));

const memory = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => {
    memory.set(key, value);
  },
  removeItem: (key: string) => {
    memory.delete(key);
  },
  clear: () => memory.clear(),
  key: () => null,
  length: 0,
});

const { useStudyStore } = await import("../../state/studyStore");
const { SolutionsCatalogue } = await import("./SolutionsCatalogue");

describe("SolutionsCatalogue", () => {
  beforeEach(() => {
    memory.clear();
    resetSolutionsCatalogueForTests({
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => {
        memory.set(key, value);
      },
    });
    useStudyStore.setState({
      phase: "complete",
      solutionId: "sol-1",
      status: {
        running: false,
        paused: false,
        cancelled: false,
        status_generation: 1,
        solution_id: "sol-1",
        has_training: true,
        can_continue: true,
      },
      draft: { ...useStudyStore.getState().draft, solutionPath: "" },
      saveSolution: vi.fn(async (path: string) => ({ ok: true as const, path })),
      openSolution: vi.fn(async (path: string) => ({ ok: true as const, path })),
      updateDraft: vi.fn(),
      loadRecent: vi.fn(async () => undefined),
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("creates a folder, saves into it, and reopens from the catalogue", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SolutionsCatalogue mode="save" onClose={onClose} />);

    await user.type(screen.getByLabelText("New folder name"), "SRP");
    await user.click(screen.getByRole("button", { name: "Add folder" }));
    expect(screen.getByRole("option", { name: "SRP" })).toBeTruthy();

    await user.selectOptions(screen.getByLabelText("Folder for saved solution"), "SRP");
    await user.type(
      screen.getByLabelText("Name for saved solution"),
      "Flop probe",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(useStudyStore.getState().saveSolution).toHaveBeenCalledWith(
      "/tmp/holdem-study-solutions/SRP/Flop probe.psol",
      { studyOnly: true },
    );
    expect(onClose).toHaveBeenCalled();
    expect(memory.get(SOLUTIONS_CATALOGUE_STORAGE_KEY)).toContain("Flop probe");

    onClose.mockReset();
    cleanup();
    render(<SolutionsCatalogue mode="open" onClose={onClose} />);
    const list = screen.getByLabelText("Saved solutions");
    expect(within(list).getByText("Flop probe")).toBeTruthy();
    await user.click(within(list).getByRole("button", { name: "Open" }));
    expect(useStudyStore.getState().openSolution).toHaveBeenCalledWith(
      "/tmp/holdem-study-solutions/SRP/Flop probe.psol",
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("saves a Continue checkpoint when Mode is Continue", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SolutionsCatalogue mode="save" onClose={onClose} />);

    await user.type(
      screen.getByLabelText("Name for saved solution"),
      "Checkpoint",
    );
    await user.selectOptions(screen.getByLabelText("Save mode"), "checkpoint");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(useStudyStore.getState().saveSolution).toHaveBeenCalledWith(
      "/tmp/holdem-study-solutions/Checkpoint.psol",
      { studyOnly: false },
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("disables Continue mode without trainer state", () => {
    useStudyStore.setState({
      status: {
        running: false,
        paused: false,
        cancelled: false,
        status_generation: 2,
        solution_id: "sol-1",
        has_training: false,
        can_continue: false,
      },
    });
    render(<SolutionsCatalogue mode="save" onClose={vi.fn()} />);
    const mode = screen.getByLabelText("Save mode") as HTMLSelectElement;
    expect(mode.value).toBe("study");
    const continueOpt = within(mode).getByRole("option", {
      name: "Continue",
    }) as HTMLOptionElement;
    expect(continueOpt.disabled).toBe(true);
  });
});
