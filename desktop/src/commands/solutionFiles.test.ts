import { describe, expect, it, vi } from "vitest";
import {
  openSolutionFile,
  saveSolutionFile,
  saveSolutionFileAs,
} from "./solutionFiles";

function makeDeps(overrides: Partial<Parameters<typeof openSolutionFile>[0]> = {}) {
  return {
    getSolutionPath: () => "",
    updateDraft: vi.fn(),
    openSolution: vi.fn(async () => undefined),
    saveSolution: vi.fn(async () => undefined),
    pickOpenPath: vi.fn(async () => null as string | null),
    pickSavePath: vi.fn(async () => null as string | null),
    ...overrides,
  };
}

describe("openSolutionFile", () => {
  it("opens the picked path and updates the draft", async () => {
    const deps = makeDeps({
      pickOpenPath: vi.fn(async () => "/tmp/spot.psol"),
    });
    await expect(openSolutionFile(deps)).resolves.toBe(true);
    expect(deps.updateDraft).toHaveBeenCalledWith({ solutionPath: "/tmp/spot.psol" });
    expect(deps.openSolution).toHaveBeenCalledWith("/tmp/spot.psol");
  });

  it("leaves the study alone when the picker is cancelled", async () => {
    const deps = makeDeps({
      pickOpenPath: vi.fn(async () => null),
    });
    await expect(openSolutionFile(deps)).resolves.toBe(false);
    expect(deps.updateDraft).not.toHaveBeenCalled();
    expect(deps.openSolution).not.toHaveBeenCalled();
  });
});

describe("saveSolutionFile", () => {
  it("saves to the existing path without prompting", async () => {
    const deps = makeDeps({
      getSolutionPath: () => "/tmp/existing.psol",
      pickSavePath: vi.fn(async () => "/tmp/other.psol"),
    });
    await expect(saveSolutionFile(deps)).resolves.toBe(true);
    expect(deps.pickSavePath).not.toHaveBeenCalled();
    expect(deps.updateDraft).toHaveBeenCalledWith({ solutionPath: "/tmp/existing.psol" });
    expect(deps.saveSolution).toHaveBeenCalled();
  });

  it("prompts Save As when no path is set", async () => {
    const deps = makeDeps({
      getSolutionPath: () => "  ",
      pickSavePath: vi.fn(async () => "/tmp/new.psol"),
    });
    await expect(saveSolutionFile(deps)).resolves.toBe(true);
    expect(deps.pickSavePath).toHaveBeenCalled();
    expect(deps.updateDraft).toHaveBeenCalledWith({ solutionPath: "/tmp/new.psol" });
    expect(deps.saveSolution).toHaveBeenCalled();
  });

  it("leaves the study alone when Save As is cancelled", async () => {
    const deps = makeDeps({
      getSolutionPath: () => "",
      pickSavePath: vi.fn(async () => null),
    });
    await expect(saveSolutionFile(deps)).resolves.toBe(false);
    expect(deps.updateDraft).not.toHaveBeenCalled();
    expect(deps.saveSolution).not.toHaveBeenCalled();
  });
});

describe("saveSolutionFileAs", () => {
  it("always prompts and saves the picked path", async () => {
    const deps = makeDeps({
      getSolutionPath: () => "/tmp/existing.psol",
      pickSavePath: vi.fn(async (defaultPath?: string) => {
        expect(defaultPath).toBe("/tmp/existing.psol");
        return "/tmp/renamed.psol";
      }),
    });
    await expect(saveSolutionFileAs(deps)).resolves.toBe(true);
    expect(deps.updateDraft).toHaveBeenCalledWith({ solutionPath: "/tmp/renamed.psol" });
    expect(deps.saveSolution).toHaveBeenCalled();
  });

  it("leaves the study alone on cancel", async () => {
    const deps = makeDeps({
      getSolutionPath: () => "/tmp/existing.psol",
      pickSavePath: vi.fn(async () => null),
    });
    await expect(saveSolutionFileAs(deps)).resolves.toBe(false);
    expect(deps.updateDraft).not.toHaveBeenCalled();
    expect(deps.saveSolution).not.toHaveBeenCalled();
  });
});
