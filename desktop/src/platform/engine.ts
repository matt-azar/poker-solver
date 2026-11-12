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

function asEndpoint(raw: unknown): EngineEndpoint | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const status = typeof value.status === "string" ? value.status : null;
  const port = typeof value.port === "number" ? value.port : null;
  const baseUrl = typeof value.baseUrl === "string" ? value.baseUrl : null;
  const launchId = typeof value.launchId === "string" ? value.launchId : null;
  const protocol = typeof value.protocol === "number" ? value.protocol : null;
  const maxPairRunouts =
    typeof value.maxPairRunouts === "number" ? value.maxPairRunouts : null;
  if (
    status == null ||
    port == null ||
    baseUrl == null ||
    launchId == null ||
    protocol == null ||
    maxPairRunouts == null
  ) {
    return null;
  }
  return { status, port, baseUrl, launchId, protocol, maxPairRunouts };
}

async function ensureHttpExplorer(): Promise<EnsureEngineResult> {
  const transport = setHttpFallbackTransport();
  try {
    const raw = await invoke("ensure_engine");
    const endpoint = asEndpoint(raw);
    if (!endpoint) {
      return {
        ok: false,
        status: "unknown",
        error: "ensure_engine returned an unexpected endpoint payload",
        transport,
      };
    }
    engineClient.setBaseUrl(endpoint.baseUrl);
    return {
      ok: true,
      status: `${endpoint.status} — ${transport.label}`,
      endpoint,
      transport,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    let status = "unknown";
    try {
      status = String(await invoke("engine_status"));
    } catch {
      // ignore
    }
    return { ok: false, status, error, transport };
  }
}

/**
 * Prefer `solver-engine` typed IPC (Zig path). If the sidecar is missing or
 * fails ready, fall back to HTTP `holdem-explorer` with an explicit temporary
 * label. Browser / Vite-dev without Tauri returns ok with a note.
 *
 * Override with `VITE_SOLVER_TRANSPORT=http` to force the HTTP explorer path.
 */
export async function ensureEngine(): Promise<EnsureEngineResult> {
  if (!isTauriRuntime()) {
    const transport = setHttpFallbackTransport("browser — use a separate explorer process");
    return {
      ok: true,
      status: "browser — use a separate explorer process",
      transport,
    };
  }

  const forceHttp =
    typeof import.meta.env.VITE_SOLVER_TRANSPORT === "string" &&
    import.meta.env.VITE_SOLVER_TRANSPORT.toLowerCase() === "http";

  if (!forceHttp) {
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
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(
        "[tauri] solver-engine IPC unavailable; using HTTP explorer fallback (temporary)",
        detail,
      );
    }
  }

  return ensureHttpExplorer();
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
