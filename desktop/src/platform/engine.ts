/** Tauri engine sidecar helpers — no-ops / soft-fail in the browser. */

import { invoke } from "@tauri-apps/api/core";
import { engineClient } from "../engine/client";
import {
  ensureSolverEngineIpc,
  getActiveTransport,
  setHttpFallbackTransport,
  type ActiveTransport,
} from "../engine/transport";
import { isTauriRuntime } from "./index";

export type EngineEndpoint = {
  status: string;
  port: number;
  baseUrl: string;
  launchId: string;
  protocol: number;
  maxPairRunouts: number;
};

export type EnsureEngineResult =
  | {
      ok: true;
      status: string;
      endpoint?: EngineEndpoint;
      transport: ActiveTransport;
    }
  | { ok: false; status: string; error: string; transport: ActiveTransport };

/**
 * Packaged Study uses Zig `solver-engine` typed IPC only.
 * Browser / Vite-dev without Tauri returns ok with a note (separate process).
 */
export async function ensureEngine(): Promise<EnsureEngineResult> {
  if (!isTauriRuntime()) {
    const transport = setHttpFallbackTransport(
      "browser — use a separate explorer process",
    );
    return {
      ok: true,
      status: "browser — use a separate explorer process",
      transport,
    };
  }

  try {
    const ipc = await ensureSolverEngineIpc();
    // IPC sessions do not use an HTTP base URL.
    engineClient.setBaseUrl(null);
    return {
      ok: true,
      status: ipc.label,
      transport: ipc,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const transport = setHttpFallbackTransport(`solver-engine unavailable: ${error}`);
    let status = "solver-engine unavailable";
    try {
      const info = await invoke("solver_engine_info");
      if (info && typeof info === "object" && typeof (info as { status?: unknown }).status === "string") {
        status = (info as { status: string }).status;
      }
    } catch {
      // ignore
    }
    return { ok: false, status, error, transport };
  }
}

export async function readEngineStatus(): Promise<string | null> {
  if (!isTauriRuntime()) {
    return null;
  }
  try {
    const transport = getActiveTransport();
    if (transport.kind === "ipc") {
      return transport.label;
    }
    return String(await invoke("engine_status"));
  } catch {
    return null;
  }
}
