/**
 * Limited river live-solving beta — browser entry separate from
 * precomputed `?demo=` and private QA `?preview=`.
 */
import { SOLVER_ENGINE_PROTOCOL } from "../engine/ipcProtocol";
import {
  installFixtureIpcHandler,
  setIpcTransport,
} from "../engine/transport";
import { isPublicDemoBuild } from "../demo/demoMode";
import { RiverBetaApi, type RiverBetaMetrics } from "./api";
import { createRiverBetaIpcHandler } from "./liveTransport";

export type RiverBetaBootConfig = {
  baseUrl: string;
  sessionId: string;
  autoSolved: boolean;
  metrics: RiverBetaMetrics | null;
};

let activeApi: RiverBetaApi | null = null;
let activeConfig: RiverBetaBootConfig | null = null;
const LISTENERS = new Set<() => void>();

function notify(): void {
  for (const listener of LISTENERS) listener();
}

export function subscribeRiverBetaMode(listener: () => void): () => void {
  LISTENERS.add(listener);
  return () => {
    LISTENERS.delete(listener);
  };
}

export function getActiveRiverBetaConfig(): RiverBetaBootConfig | null {
  return activeConfig;
}

export function getActiveRiverBetaApi(): RiverBetaApi | null {
  return activeApi;
}

export function parseRiverBetaSearch(search: string): boolean {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const raw = (params.get("river-beta") || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function isBrowserRiverBetaMode(
  search: string = typeof window !== "undefined" ? window.location.search : "",
): boolean {
  // Public static demo never arms live solving.
  if (isPublicDemoBuild()) return false;
  return parseRiverBetaSearch(search);
}

function armTransport(api: RiverBetaApi): void {
  installFixtureIpcHandler(createRiverBetaIpcHandler(api));
  setIpcTransport({
    protocol: SOLVER_ENGINE_PROTOCOL,
    launchId: api.getSessionId() || "river-beta",
    sidecar: "river-beta-service",
    workers: 1,
    label: "river beta IPC (HTTPS → solver-engine)",
  });
}

/**
 * Create an isolated service session and optionally auto-solve the default
 * river config so Study has a browsable solution immediately.
 */
export async function installBrowserRiverBetaTransport(
  search: string = typeof window !== "undefined" ? window.location.search : "",
  opts?: { autoSolve?: boolean },
): Promise<RiverBetaBootConfig | null> {
  if (!isBrowserRiverBetaMode(search)) {
    return null;
  }
  const api = new RiverBetaApi();
  const session = await api.createSession();
  armTransport(api);

  let autoSolved = false;
  const autoSolve = opts?.autoSolve !== false;
  if (autoSolve) {
    try {
      const result = await api.solve({});
      autoSolved = Boolean(result.ok);
      // Brief poll so first Study status often sees a published solution.
      for (let i = 0; i < 40; i++) {
        const env = await api.ipc("status", null);
        const body = (env.body ?? {}) as Record<string, unknown>;
        if (!body.running) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      try {
        const info = await api.sessionInfo();
        if (info.metrics) api.lastMetrics = info.metrics;
      } catch {
        /* metrics optional */
      }
    } catch (err) {
      console.warn("[river-beta] auto-solve failed", err);
    }
  }

  activeApi = api;
  activeConfig = {
    baseUrl: api.baseUrl,
    sessionId: session.session_id,
    autoSolved,
    metrics: api.lastMetrics,
  };
  notify();
  return activeConfig;
}

export async function refreshRiverBetaMetrics(): Promise<RiverBetaMetrics | null> {
  if (!activeApi || !activeConfig) return null;
  try {
    const info = await activeApi.sessionInfo();
    activeConfig = {
      ...activeConfig,
      metrics: info.metrics ?? activeApi.lastMetrics,
    };
    notify();
    return activeConfig.metrics;
  } catch {
    return activeConfig.metrics;
  }
}

export async function riverBetaResolve(opts?: {
  iterations?: number;
  time_limit?: number;
}): Promise<void> {
  if (!activeApi) throw new Error("river beta not active");
  await activeApi.resolve(opts);
  await refreshRiverBetaMetrics();
}

export async function riverBetaCancel(): Promise<void> {
  if (!activeApi) return;
  await activeApi.cancel();
  await refreshRiverBetaMetrics();
}

export async function riverBetaResolveDefault(): Promise<void> {
  if (!activeApi) throw new Error("river beta not active");
  await activeApi.solve({});
  await refreshRiverBetaMetrics();
  if (activeConfig) {
    activeConfig = { ...activeConfig, autoSolved: true };
    notify();
  }
}

/** Vitest helper */
export function clearBrowserRiverBetaForTests(): void {
  activeApi = null;
  activeConfig = null;
  installFixtureIpcHandler(null);
  notify();
}
