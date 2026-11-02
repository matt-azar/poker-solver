import { getPlatform } from "../platform/browser";

/** Shared deps so File menu and Study toolbar open/save the same way. */
export interface SolutionFileDeps {
  getSolutionPath: () => string;
  updateDraft: (partial: { solutionPath: string }) => void;
  openSolution: (path: string) => Promise<void>;
  saveSolution: () => Promise<void>;
  pickOpenPath?: () => Promise<string | null>;
  pickSavePath?: (defaultPath?: string) => Promise<string | null>;
}

/**
 * Prompt for a path via the platform open picker, then open it.
 * Cancel (null) leaves the study alone.
 */
export async function openSolutionFile(deps: SolutionFileDeps): Promise<boolean> {
  const pick = deps.pickOpenPath ?? (() => getPlatform().pickOpenPath());
  const path = await pick();
  if (!path) {
    return false;
  }
  deps.updateDraft({ solutionPath: path });
  await deps.openSolution(path);
  return true;
}

/**
 * Save the current solution.
 * When a path is already set, reuse it; otherwise prompt with Save As (pickSavePath).
 * Cancel leaves the study alone.
 */
export async function saveSolutionFile(deps: SolutionFileDeps): Promise<boolean> {
  const existing = deps.getSolutionPath().trim();
  if (existing) {
    deps.updateDraft({ solutionPath: existing });
    await deps.saveSolution();
    return true;
  }
  const pick = deps.pickSavePath ?? ((defaultPath?: string) => getPlatform().pickSavePath(defaultPath));
  const path = await pick(existing);
  if (!path) {
    return false;
  }
  deps.updateDraft({ solutionPath: path });
  await deps.saveSolution();
  return true;
}

/**
 * Always prompt with the save picker (File → Save solution…).
 * Cancel leaves the study alone.
 */
export async function saveSolutionFileAs(deps: SolutionFileDeps): Promise<boolean> {
  const pick = deps.pickSavePath ?? ((defaultPath?: string) => getPlatform().pickSavePath(defaultPath));
  const path = await pick(deps.getSolutionPath().trim() || undefined);
  if (!path) {
    return false;
  }
  deps.updateDraft({ solutionPath: path });
  await deps.saveSolution();
  return true;
}
