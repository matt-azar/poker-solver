/** Tauri engine sidecar helpers — no-ops / soft-fail in the browser. */

import { invoke } from "@tauri-apps/api/core";
import {
  getActiveDemoConfig,
  installBrowserDemoTransport,
  isBrowserDemoMode,
  isPublicDemoBuild,
} from "../demo/demoMode";
import { engineClient } from "../engine/client";
import {
  ensureSolverEngineIpc,
  getActiveTransport,
  setNoEngineTransport,
  type ActiveTransport,
} from "../engine/transport";
import {
  getActivePreviewConfig,
  installBrowserPreviewTransport,
  isBrowserPreviewMode,
  rearmBrowserPreviewTransport,
} from "../preview/previewMode";
import {
  getActiveRiverBetaConfig,
  installBrowserRiverBetaTransport,
  isBrowserRiverBetaMode,
  reconnectRiverBeta,
} from "../river-beta/riverBetaMode";
import { isTauriRuntime } from "./index";

export type EnsureEngineResult =
  | {
      ok: true;
      status: string;
      transport: ActiveTransport;
    }
  | { ok: false; status: string; error: string; transport: ActiveTransport };

/**
 * Packaged Study uses Zig `solver-engine` typed IPC only.
 * Browser / Vite-dev without Tauri cannot reach the engine — unless a
 * public precomputed demo (`?demo=…` / `VITE_PUBLIC_DEMO`), the limited
 * river live-solving beta (`?river-beta=1`), or a private recorded-fixture
 * preview (`?preview=…`) is selected.
 *
 * Public demo, river beta, and private QA stay separate entry points: the
 * public build never arms preview failure-simulation or live river beta.
 */
export async function ensureEngine(): Promise<EnsureEngineResult> {
  if (!isTauriRuntime()) {
    // Public demo first — never mix private QA failure simulation into it.
    if (isBrowserDemoMode()) {
      const demo =
        getActiveDemoConfig() ?? (await installBrowserDemoTransport());
      if (demo) {
        engineClient.setBaseUrl(null);
        const transport = getActiveTransport();
        return {
          ok: true,
          status: transport.kind === "ipc" ? transport.label : demo.exampleId,
          transport,
        };
      }
    }
    // Limited river live beta (HTTPS → isolated solver-engine IPC). Not in
    // the public precomputed demo build; turn/flop remain out of scope.
    if (!isPublicDemoBuild() && isBrowserRiverBetaMode()) {
      try {
        const existing = getActiveRiverBetaConfig();
        const beta =
          existing?.connectionState === "connected"
            ? existing
            : existing
              ? await reconnectRiverBeta({ autoSolve: true })
              : await installBrowserRiverBetaTransport();
        if (beta?.connectionState === "connected") {
          engineClient.setBaseUrl(null);
          const transport = getActiveTransport();
          return {
            ok: true,
            status:
              transport.kind === "ipc"
                ? transport.label
                : `river-beta ${beta.sessionId.slice(0, 8)}`,
            transport,
          };
        }
        const error =
          beta?.lastError || "river-beta session not connected";
        const transport = setNoEngineTransport(`river-beta unavailable: ${error}`);
        return {
          ok: false,
          status: "river-beta unavailable",
          error,
          transport,
        };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const transport = setNoEngineTransport(`river-beta unavailable: ${error}`);
        return {
          ok: false,
          status: "river-beta unavailable",
          error,
          transport,
        };
      }
    }
    if (!isPublicDemoBuild() && isBrowserPreviewMode()) {
      // First boot installs; Reconnect re-arms (clears dropped-connection).
      const preview = getActivePreviewConfig()
        ? rearmBrowserPreviewTransport()
        : installBrowserPreviewTransport();
      if (preview) {
        engineClient.setBaseUrl(null);
        const transport = getActiveTransport();
        return {
          ok: true,
          status: transport.kind === "ipc" ? transport.label : preview.scenario,
          transport,
        };
      }
    }
    const transport = setNoEngineTransport(
      "browser — Study engine requires the Tauri shell + solver-engine",
    );
    return {
      ok: true,
      status: "browser — Study engine requires the Tauri shell + solver-engine",
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
    // Stay on the no-engine label — never leave an empty HTTP base URL that
    // status/library can fetch("") against (#288-class Engine unreachable).
    engineClient.setBaseUrl(null);
    const transport = setNoEngineTransport(`solver-engine unavailable: ${error}`);
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
    const info = await invoke("solver_engine_info");
    if (info && typeof info === "object" && typeof (info as { status?: unknown }).status === "string") {
      return (info as { status: string }).status;
    }
    return null;
  } catch {
    return null;
  }
}
