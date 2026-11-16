/**
 * Limited river live-solving beta — browser entry separate from
 * precomputed `?demo=` and private QA `?preview=`.
 *
 * Expansion: session lifecycle UX — published bounds, idle remaining,
 * boot/solve errors, and reconnect after idle reap / service loss.
 */
import { SOLVER_ENGINE_PROTOCOL } from "../engine/ipcProtocol";
import {
  installFixtureIpcHandler,
  setIpcTransport,
  setNoEngineTransport,
} from "../engine/transport";
import { isPublicDemoBuild } from "../demo/demoMode";
import {
  RiverBetaApi,
  RiverBetaApiError,
  type RiverBetaBoundsInfo,
  type RiverBetaMetrics,
} from "./api";
import { createRiverBetaIpcHandler } from "./liveTransport";

export type RiverBetaConnectionState =
  | "connected"
  | "lost"
  | "unavailable"
  | "reconnecting";

export type RiverBetaBootConfig = {
  baseUrl: string;
  sessionId: string;
  autoSolved: boolean;
  metrics: RiverBetaMetrics | null;
  bounds: RiverBetaBoundsInfo | null;
  idleRemainingSec: number | null;
  connectionState: RiverBetaConnectionState;
  lastError: string | null;
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
  installFixtureIpcHandler(createRiverBetaIpcHandler(api, markSessionLost));
  setIpcTransport({
    protocol: SOLVER_ENGINE_PROTOCOL,
    launchId: api.getSessionId() || "river-beta",
    sidecar: "river-beta-service",
    workers: 1,
    label: "river beta IPC (HTTPS → solver-engine)",
  });
}

function patchConfig(patch: Partial<RiverBetaBootConfig>): void {
  if (!activeConfig) return;
  activeConfig = { ...activeConfig, ...patch };
  notify();
}

function markSessionLost(message?: string): void {
  if (!activeApi || !activeConfig) return;
  if (activeConfig.connectionState === "lost") return;
  activeApi.clearLocalSession();
  patchConfig({
    connectionState: "lost",
    lastError:
      message ||
      "Session expired or was reaped (idle TTL / concurrency). Reconnect to continue.",
    sessionId: "",
    idleRemainingSec: 0,
  });
  setNoEngineTransport("river-beta session lost");
}

function isNoSessionError(err: unknown): boolean {
  return err instanceof RiverBetaApiError && err.code === "no_session";
}

function errorMessage(err: unknown): string {
  if (err instanceof RiverBetaApiError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

async function waitForSolveIdle(api: RiverBetaApi): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const env = await api.ipc("status", null);
    const body = (env.body ?? {}) as Record<string, unknown>;
    if (!body.running) break;
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function bootSession(
  api: RiverBetaApi,
  opts?: { autoSolve?: boolean },
): Promise<RiverBetaBootConfig> {
  let bounds: RiverBetaBoundsInfo | null = null;
  try {
    bounds = await api.bounds();
  } catch {
    /* bounds optional at boot — session create still required */
  }

  try {
    await api.health();
  } catch (err) {
    throw new RiverBetaApiError(
      "unavailable",
      `river-beta service unreachable at ${api.baseUrl}: ${errorMessage(err)}`,
    );
  }

  const session = await api.createSession();
  armTransport(api);

  let autoSolved = false;
  let lastError: string | null = null;
  const autoSolve = opts?.autoSolve !== false;
  if (autoSolve) {
    try {
      const result = await api.solve({});
      autoSolved = Boolean(result.ok);
      if (!result.ok) {
        lastError = "Auto-solve did not accept (see service logs)";
      }
      await waitForSolveIdle(api);
      try {
        const info = await api.sessionInfo();
        if (info.metrics) api.lastMetrics = info.metrics;
        // Merge session caps onto published /v1/bounds (keep summary).
        if (info.bounds) bounds = { ...(bounds ?? {}), ...info.bounds };
      } catch {
        /* metrics optional */
      }
    } catch (err) {
      lastError = errorMessage(err);
      console.warn("[river-beta] auto-solve failed", err);
    }
  }

  return {
    baseUrl: api.baseUrl,
    sessionId: session.session_id,
    autoSolved,
    metrics: api.lastMetrics,
    bounds: bounds ?? api.lastBounds,
    idleRemainingSec: api.lastIdleRemainingSec,
    connectionState: "connected",
    lastError,
  };
}

/**
 * Create an isolated service session and optionally auto-solve the default
 * river config so Study has a browsable solution immediately.
 *
 * On service unreachable, still publishes a degraded config so the banner
 * can offer Retry / Reconnect without leaving the visitor with a blank shell.
 */
export async function installBrowserRiverBetaTransport(
  search: string = typeof window !== "undefined" ? window.location.search : "",
  opts?: { autoSolve?: boolean },
): Promise<RiverBetaBootConfig | null> {
  if (!isBrowserRiverBetaMode(search)) {
    return null;
  }
  const api = new RiverBetaApi();
  try {
    const config = await bootSession(api, opts);
    activeApi = api;
    activeConfig = config;
    notify();
    return activeConfig;
  } catch (err) {
    const message = errorMessage(err);
    console.warn("[river-beta] boot failed", err);
    activeApi = api;
    activeConfig = {
      baseUrl: api.baseUrl,
      sessionId: "",
      autoSolved: false,
      metrics: null,
      bounds: api.lastBounds,
      idleRemainingSec: null,
      connectionState: "unavailable",
      lastError: message,
    };
    setNoEngineTransport(`river-beta unavailable: ${message}`);
    notify();
    // Still throw so ensureEngine reports ok:false; banner stays mounted.
    throw err instanceof Error ? err : new Error(message);
  }
}

export async function refreshRiverBetaMetrics(): Promise<RiverBetaMetrics | null> {
  if (!activeApi || !activeConfig) return null;
  if (
    activeConfig.connectionState === "unavailable" ||
    activeConfig.connectionState === "reconnecting"
  ) {
    return activeConfig.metrics;
  }
  if (!activeApi.getSessionId()) {
    if (activeConfig.connectionState !== "lost") {
      markSessionLost();
    }
    return activeConfig.metrics;
  }
  try {
    const info = await activeApi.sessionInfo();
    const mergedBounds = info.bounds
      ? { ...(activeConfig.bounds ?? activeApi.lastBounds ?? {}), ...info.bounds }
      : (activeConfig.bounds ?? activeApi.lastBounds);
    activeConfig = {
      ...activeConfig,
      metrics: info.metrics ?? activeApi.lastMetrics,
      bounds: mergedBounds,
      idleRemainingSec:
        typeof info.idle_remaining_sec === "number"
          ? info.idle_remaining_sec
          : activeApi.lastIdleRemainingSec,
      connectionState: "connected",
      lastError: activeConfig.lastError,
      sessionId: info.session_id || activeConfig.sessionId,
    };
    notify();
    return activeConfig.metrics;
  } catch (err) {
    if (isNoSessionError(err)) {
      markSessionLost(errorMessage(err));
      return activeConfig?.metrics ?? null;
    }
    patchConfig({ lastError: errorMessage(err) });
    return activeConfig.metrics;
  }
}

/**
 * Tear down (best-effort) and create a fresh isolated session + optional solve.
 * Used after idle reap, concurrency eviction, or service restart.
 */
export async function reconnectRiverBeta(opts?: {
  autoSolve?: boolean;
}): Promise<RiverBetaBootConfig> {
  const baseUrl = activeApi?.baseUrl ?? new RiverBetaApi().baseUrl;
  patchConfig({ connectionState: "reconnecting", lastError: null });

  if (activeApi) {
    try {
      await activeApi.destroySession();
    } catch {
      activeApi.clearLocalSession();
    }
  }

  const api = new RiverBetaApi(baseUrl);
  try {
    const config = await bootSession(api, { autoSolve: opts?.autoSolve !== false });
    activeApi = api;
    activeConfig = config;
    notify();
    return config;
  } catch (err) {
    const message = errorMessage(err);
    activeApi = api;
    activeConfig = {
      baseUrl,
      sessionId: "",
      autoSolved: false,
      metrics: null,
      bounds: api.lastBounds ?? activeConfig?.bounds ?? null,
      idleRemainingSec: null,
      connectionState: "unavailable",
      lastError: message,
    };
    setNoEngineTransport(`river-beta unavailable: ${message}`);
    notify();
    throw err instanceof Error ? err : new Error(message);
  }
}

export async function riverBetaResolve(opts?: {
  iterations?: number;
  time_limit?: number;
}): Promise<void> {
  if (!activeApi?.getSessionId()) throw new Error("river beta not active");
  try {
    await activeApi.resolve(opts);
    await refreshRiverBetaMetrics();
  } catch (err) {
    if (isNoSessionError(err)) markSessionLost(errorMessage(err));
    throw err;
  }
}

export async function riverBetaCancel(): Promise<void> {
  if (!activeApi?.getSessionId()) return;
  try {
    await activeApi.cancel();
    await refreshRiverBetaMetrics();
  } catch (err) {
    if (isNoSessionError(err)) markSessionLost(errorMessage(err));
  }
}

export async function riverBetaResolveDefault(): Promise<void> {
  if (!activeApi?.getSessionId()) throw new Error("river beta not active");
  try {
    await activeApi.solve({});
    await refreshRiverBetaMetrics();
    if (activeConfig) {
      activeConfig = {
        ...activeConfig,
        autoSolved: true,
        lastError: null,
        connectionState: "connected",
      };
      notify();
    }
  } catch (err) {
    if (isNoSessionError(err)) markSessionLost(errorMessage(err));
    throw err;
  }
}

/** Vitest helper */
export function clearBrowserRiverBetaForTests(): void {
  activeApi = null;
  activeConfig = null;
  installFixtureIpcHandler(null);
  notify();
}
