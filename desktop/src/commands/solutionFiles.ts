import { getPlatform } from "../platform/browser";

/** Typed open/save outcome — never report success when the store rejected. */
export type SolutionFileResult =
  | { ok: true; path: string }
  | { ok: false; error: string; cancelled?: boolean };

/** Result from the study store's transactional open. */
export type OpenSolutionResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

/** Shared deps so File menu and Study toolbar open/save the same way. */
export interface SolutionFileDeps {
  getSolutionPath: () => string;
  updateDraft: (partial: { solutionPath: string }) => void;
  openSolution: (path: string) => Promise<OpenSolutionResult | void>;
  saveSolution: () => Promise<void>;
  pickOpenPath?: () => Promise<string | null>;
  pickSavePath?: (defaultPath?: string) => Promise<string | null>;
}

function asOpenResult(
  path: string,
  result: OpenSolutionResult | void,
): SolutionFileResult {
  if (result && typeof result === "object" && "ok" in result) {
    if (result.ok) {
      return { ok: true, path: result.path || path };
    }
    return { ok: false, error: result.error || "Open failed" };
  }
  // Legacy void-returning openSolution (tests/mocks): treat as success.
  return { ok: true, path };
}

/**
 * Prompt for a path via the platform open picker, then open it.
 * Cancel (null) leaves the study alone. Does not write the draft path
 * before open succeeds — the store commits document identity on success.
 */
export async function openSolutionFile(
  deps: SolutionFileDeps,
): Promise<SolutionFileResult> {
  const pick = deps.pickOpenPath ?? (() => getPlatform().pickOpenPath());
  const path = await pick();
  if (!path) {
    return { ok: false, error: "cancelled", cancelled: true };
  }
  // Stage only: pass the path to openSolution. Do not updateDraft here.
  const result = await deps.openSolution(path);
  return asOpenResult(path, result);
}

/**
 * Save the current solution.
 * When a path is already set, reuse it; otherwise prompt with Save As (pickSavePath).
 * Cancel leaves the study alone.
 */
export async function saveSolutionFile(
  deps: SolutionFileDeps,
): Promise<SolutionFileResult> {
  const existing = deps.getSolutionPath().trim();
  if (existing) {
    deps.updateDraft({ solutionPath: existing });
    await deps.saveSolution();
    return { ok: true, path: existing };
  }
  const pick = deps.pickSavePath ?? ((defaultPath?: string) => getPlatform().pickSavePath(defaultPath));
  const path = await pick(existing);
  if (!path) {
    return { ok: false, error: "cancelled", cancelled: true };
  }
  deps.updateDraft({ solutionPath: path });
  await deps.saveSolution();
  return { ok: true, path };
}

/**
 * Always prompt with the save picker (File → Save solution…).
 * Cancel leaves the study alone.
 */
export async function saveSolutionFileAs(
  deps: SolutionFileDeps,
): Promise<SolutionFileResult> {
  const pick = deps.pickSavePath ?? ((defaultPath?: string) => getPlatform().pickSavePath(defaultPath));
  const path = await pick(deps.getSolutionPath().trim() || undefined);
  if (!path) {
    return { ok: false, error: "cancelled", cancelled: true };
  }
  deps.updateDraft({ solutionPath: path });
  await deps.saveSolution();
  return { ok: true, path };
}
