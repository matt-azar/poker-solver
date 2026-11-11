/** Tauri engine sidecar helpers — no-ops / soft-fail in the browser. */

import { invoke } from "@tauri-apps/api/core";
import { engineClient } from "../engine/client";
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
  | { ok: true; status: string; endpoint?: EngineEndpoint }
  | { ok: false; status: string; error: string };

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

/**
 * Ask the Tauri shell to spawn/wait for an owned holdem-explorer child and
 * bind the shared engine client to its runtime base URL.
 * Browser / Vite-dev without Tauri returns ok with a note (external explorer).
 */
export async function ensureEngine(): Promise<EnsureEngineResult> {
  if (!isTauriRuntime()) {
    return { ok: true, status: "browser — use a separate explorer process" };
  }
  try {
    const raw = await invoke("ensure_engine");
    const endpoint = asEndpoint(raw);
    if (!endpoint) {
      return {
        ok: false,
        status: "unknown",
        error: "ensure_engine returned an unexpected endpoint payload",
      };
    }
    engineClient.setBaseUrl(endpoint.baseUrl);
    return { ok: true, status: endpoint.status, endpoint };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    let status = "unknown";
    try {
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
    return String(await invoke("engine_status"));
  } catch {
    return null;
  }
}
