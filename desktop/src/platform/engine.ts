/** Tauri engine sidecar helpers — no-ops / soft-fail in the browser. */

import { isTauriRuntime } from "./index";

export type EnsureEngineResult =
  | { ok: true; status: string }
  | { ok: false; status: string; error: string };

/**
 * Ask the Tauri shell to spawn/wait for holdem-explorer on 127.0.0.1:8765.
 * Browser / Vite-dev without Tauri returns ok with a note (external explorer).
 */
export async function ensureEngine(): Promise<EnsureEngineResult> {
  if (!isTauriRuntime()) {
    return { ok: true, status: "browser — use a separate explorer process" };
  }
  try {
    const spec = "@tauri-apps/api/core";
    const { invoke } = (await import(/* @vite-ignore */ spec)) as {
      invoke: (cmd: string) => Promise<unknown>;
    };
    const status = String(await invoke("ensure_engine"));
    return { ok: true, status };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    let status = "unknown";
    try {
      const spec = "@tauri-apps/api/core";
      const { invoke } = (await import(/* @vite-ignore */ spec)) as {
        invoke: (cmd: string) => Promise<unknown>;
      };
      status = String(await invoke("engine_status"));
    } catch {
      // ignore
    }
    return { ok: false, status, error };
  }
}

export async function readEngineStatus(): Promise<string | null> {
  if (!isTauriRuntime()) {
    return null;
  }
  try {
    const spec = "@tauri-apps/api/core";
    const { invoke } = (await import(/* @vite-ignore */ spec)) as {
      invoke: (cmd: string) => Promise<unknown>;
    };
    return String(await invoke("engine_status"));
  } catch {
    return null;
  }
}
