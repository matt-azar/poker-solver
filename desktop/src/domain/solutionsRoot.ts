/**
 * Managed solutions directory for the in-app catalogue.
 * Packaged: `%LOCALAPPDATA%/Holdem Study/solutions` (via Tauri).
 * Browser: `/tmp/holdem-study-solutions` (demo / unit paths).
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../platform";
import {
  joinSolutionsPath,
  relativeSolutionKey,
} from "./solutionsCatalogue";

export const BROWSER_SOLUTIONS_ROOT = "/tmp/holdem-study-solutions";

export async function getSolutionsRoot(): Promise<string> {
  if (isTauriRuntime()) {
    try {
      const root = (await invoke("solutions_root")) as string;
      if (typeof root === "string" && root.trim()) {
        return root.trim();
      }
    } catch {
      // Fall through to browser-style root when invoke is unavailable in tests.
    }
  }
  return BROWSER_SOLUTIONS_ROOT;
}

/** Ensure parent directories exist under the solutions root (no-op in browser). */
export async function ensureSolutionsParent(
  relativeKey: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isTauriRuntime()) {
    return { ok: true };
  }
  try {
    await invoke("solutions_ensure_parent", { relativeKey });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function resolveCatalogueSavePath(
  folder: string,
  displayName: string,
): Promise<
  | { ok: true; path: string; relativeKey: string }
  | { ok: false; error: string }
> {
  const relativeKey = relativeSolutionKey(folder, displayName);
  const parent = await ensureSolutionsParent(relativeKey);
  if (!parent.ok) {
    return parent;
  }
  const root = await getSolutionsRoot();
  return {
    ok: true,
    relativeKey,
    path: joinSolutionsPath(root, relativeKey),
  };
}
