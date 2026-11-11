import { getPlatform } from "../platform/browser";

/** Typed open/save outcome — never report success when the store rejected. */
export type SolutionFileResult =
  | { ok: true; path: string }
  | { ok: false; error: string; cancelled?: boolean };

/** Result from the study store's transactional open. */
export type OpenSolutionResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

/** Result from the study store's transactional save. */
export type SaveSolutionResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

/** Shared deps so File menu and Study toolbar open/save the same way. */
export interface SolutionFileDeps {
  getSolutionPath: () => string;
  updateDraft: (partial: { solutionPath: string }) => void;
  openSolution: (path: string) => Promise<OpenSolutionResult | void>;
  /** Pass the proposed path; the store commits draft.solutionPath only after ack. */
  saveSolution: (path: string) => Promise<SaveSolutionResult | void>;
  pickOpenPath?: () => Promise<string | null>;
  pickSavePath?: (defaultPath?: string) => Promise<string | null>;
  /**
   * Optional confirm when Save As targets a path other than the current one.
   * Return false to cancel without calling the engine.
   */
  confirmReplace?: (path: string) => boolean | Promise<boolean>;
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

function asSaveResult(
  path: string,
  result: SaveSolutionResult | void,
): SolutionFileResult {
  if (result && typeof result === "object" && "ok" in result) {
    if (result.ok) {
      return { ok: true, path: result.path || path };
    }
    return { ok: false, error: result.error || "Save failed" };
  }
  // Legacy void-returning saveSolution (tests/mocks): treat as success.
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
 * Cancel leaves the study alone. Draft path is committed only after engine ack.
 */
export async function saveSolutionFile(
  deps: SolutionFileDeps,
): Promise<SolutionFileResult> {
  const existing = deps.getSolutionPath().trim();
  if (existing) {
    const result = await deps.saveSolution(existing);
    return asSaveResult(existing, result);
  }
  const pick = deps.pickSavePath ?? ((defaultPath?: string) => getPlatform().pickSavePath(defaultPath));
  const path = await pick(existing);
  if (!path) {
    return { ok: false, error: "cancelled", cancelled: true };
  }
  const result = await deps.saveSolution(path);
  return asSaveResult(path, result);
}

/**
 * Always prompt with the save picker (File → Save solution…).
 * Cancel leaves the study alone. Draft path is committed only after engine ack.
 */
export async function saveSolutionFileAs(
  deps: SolutionFileDeps,
): Promise<SolutionFileResult> {
  const current = deps.getSolutionPath().trim();
  const pick = deps.pickSavePath ?? ((defaultPath?: string) => getPlatform().pickSavePath(defaultPath));
  const path = await pick(current || undefined);
  if (!path) {
    return { ok: false, error: "cancelled", cancelled: true };
  }
  if (path !== current && deps.confirmReplace) {
    const allowed = await deps.confirmReplace(path);
    if (!allowed) {
      return { ok: false, error: "cancelled", cancelled: true };
    }
  }
  const result = await deps.saveSolution(path);
  return asSaveResult(path, result);
}
