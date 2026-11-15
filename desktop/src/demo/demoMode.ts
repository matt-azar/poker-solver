/**
 * Public Study demo mode — precomputed packs behind the existing IPC client.
 * Private QA (`?preview=…` / `preview:scenario`) stays a separate entry.
 */
import { SOLVER_ENGINE_PROTOCOL } from "../engine/ipcProtocol";
import {
  installFixtureIpcHandler,
  setIpcTransport,
} from "../engine/transport";
import {
  createPrecomputedSession,
  loadDemoCatalog,
  type PrecomputedSession,
} from "./precomputedTransport";
import type { DemoBootConfig, DemoCatalog, DemoExampleId } from "./types";

declare global {
  interface Window {
    __STUDY_DEMO_DEBUG__?: {
      exampleId: string;
      variantId: string;
      nodeId: string | null;
      nodeEv: number | null;
      actionFrequencies: number[] | null;
      fetchedPaths: string[];
      expectedRoot?: {
        action_frequencies?: number[];
        node_ev?: number | null;
      };
    };
  }
}

let activeSession: PrecomputedSession | null = null;
let activeConfig: DemoBootConfig | null = null;
const LISTENERS = new Set<() => void>();

function notify(): void {
  for (const listener of LISTENERS) {
    listener();
  }
}

export function subscribeDemoMode(listener: () => void): () => void {
  LISTENERS.add(listener);
  return () => {
    LISTENERS.delete(listener);
  };
}

export function getActiveDemoConfig(): DemoBootConfig | null {
  return activeConfig;
}

export function getActiveDemoSession(): PrecomputedSession | null {
  return activeSession;
}

export function isPublicDemoBuild(): boolean {
  return import.meta.env.VITE_PUBLIC_DEMO === "true" ||
    import.meta.env.VITE_PUBLIC_DEMO === "1";
}

export function parseDemoSearch(search: string): {
  exampleId: DemoExampleId | null;
  variantId: string | null;
  nodeId: string | null;
} {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  // Prefer ?demo=; public build may also use bare / with catalog default.
  const rawDemo = (params.get("demo") || "").trim();
  const exampleId = rawDemo || null;
  const variantId = (params.get("variant") || "").trim() || null;
  const nodeId = (params.get("node") || "").trim() || null;
  return { exampleId, variantId, nodeId };
}

export function isBrowserDemoMode(
  search: string = typeof window !== "undefined" ? window.location.search : "",
): boolean {
  if (isPublicDemoBuild()) {
    // Public static build always boots the precomputed demo (never private QA).
    return true;
  }
  return parseDemoSearch(search).exampleId != null;
}

/** Build the shareable demo search string (no history write). */
export function formatDemoSearch(opts: {
  exampleId: string;
  variantId?: string | null;
  nodeId?: string | null;
  defaultVariant?: string | null;
}): string {
  const params = new URLSearchParams();
  params.set("demo", opts.exampleId);
  const defaultVariant = opts.defaultVariant || "baseline";
  if (opts.variantId && opts.variantId !== defaultVariant) {
    params.set("variant", opts.variantId);
  }
  if (opts.nodeId) {
    params.set("node", opts.nodeId);
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** Write shareable demo URL without reloading. */
export function writeDemoUrlState(
  opts: {
    exampleId: string;
    variantId?: string | null;
    nodeId?: string | null;
  },
  options?: { notify?: boolean },
): void {
  if (typeof window === "undefined") {
    return;
  }
  const defaultVariant = activeConfig?.manifest.default_variant ?? "baseline";
  const nextSearch = formatDemoSearch({
    ...opts,
    defaultVariant,
  });
  const next = `${window.location.pathname}${nextSearch}${window.location.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) {
    window.history.replaceState({}, "", next);
  }
  if (activeConfig) {
    const nextVariant = opts.variantId || activeConfig.variantId;
    const nextNode = opts.nodeId ?? null;
    const changed =
      activeConfig.exampleId !== opts.exampleId ||
      activeConfig.variantId !== nextVariant ||
      activeConfig.nodeId !== nextNode;
    if (changed) {
      activeConfig = {
        ...activeConfig,
        exampleId: opts.exampleId,
        variantId: nextVariant,
        nodeId: nextNode,
      };
      if (options?.notify !== false) {
        notify();
      }
    }
  } else if (options?.notify !== false) {
    notify();
  }
}

function armSession(session: PrecomputedSession): void {
  activeSession = session;
  installFixtureIpcHandler(session.handler);
  setIpcTransport({
    protocol: SOLVER_ENGINE_PROTOCOL,
    launchId: "precomputed-demo",
    sidecar: "precomputed-pack",
    workers: 0,
    label: `precomputed demo IPC (${session.exampleId}/${session.variantId})`,
  });
}

/**
 * Install precomputed transport so EngineClient uses typed IPC branches
 * (never HTTP :8765). Returns null when URL/build is not a public demo.
 */
export async function installBrowserDemoTransport(
  search: string = typeof window !== "undefined" ? window.location.search : "",
): Promise<DemoBootConfig | null> {
  if (!isBrowserDemoMode(search)) {
    activeSession = null;
    activeConfig = null;
    return null;
  }

  const parsed = parseDemoSearch(search);
  let catalog: DemoCatalog;
  try {
    catalog = await loadDemoCatalog();
  } catch (err) {
    console.error("[demo] failed to load catalog", err);
    activeSession = null;
    activeConfig = null;
    return null;
  }

  const exampleId =
    parsed.exampleId ||
    catalog.default_example ||
    catalog.examples[0]?.id ||
    "flop-explore";

  const session = await createPrecomputedSession({
    exampleId,
    variantId: parsed.variantId,
    catalog,
  });
  armSession(session);

  activeConfig = {
    exampleId: session.exampleId,
    variantId: session.variantId,
    nodeId: parsed.nodeId,
    catalog,
    manifest: session.manifest,
    basePath: session.packBase,
  };

  // Ensure shareable URL always names the example (public build default).
  writeDemoUrlState({
    exampleId: session.exampleId,
    variantId: session.variantId === session.manifest.default_variant
      ? null
      : session.variantId,
    nodeId: parsed.nodeId,
  });

  notify();
  return activeConfig;
}

/** Switch example (loads a new pack). Caller should restart Study polling. */
export async function setDemoExample(exampleId: string): Promise<DemoBootConfig | null> {
  const session = await createPrecomputedSession({
    exampleId,
    catalog: activeSession?.catalog,
  });
  armSession(session);
  activeConfig = {
    exampleId: session.exampleId,
    variantId: session.variantId,
    nodeId: null,
    catalog: session.catalog,
    manifest: session.manifest,
    basePath: session.packBase,
  };
  writeDemoUrlState({
    exampleId: session.exampleId,
    variantId: null,
    nodeId: null,
  });
  notify();
  return activeConfig;
}

/** Switch baseline vs named lock preset within the current example. */
export async function setDemoVariant(variantId: string): Promise<DemoBootConfig | null> {
  if (!activeSession || !activeConfig) {
    return null;
  }
  await activeSession.setVariant(variantId);
  activeConfig = {
    ...activeConfig,
    variantId: activeSession.variantId,
    basePath: activeSession.packBase,
    nodeId: activeConfig.nodeId,
  };
  writeDemoUrlState({
    exampleId: activeConfig.exampleId,
    variantId:
      activeSession.variantId === activeConfig.manifest.default_variant
        ? null
        : activeSession.variantId,
    nodeId: activeConfig.nodeId,
  });
  // Retarget fixture handler already points at the same session; transport label.
  armSession(activeSession);
  notify();
  return activeConfig;
}

export function clearBrowserDemoForTests(): void {
  activeSession = null;
  activeConfig = null;
  installFixtureIpcHandler(null);
  if (typeof window !== "undefined") {
    delete window.__STUDY_DEMO_DEBUG__;
  }
  notify();
}

export function publishDemoDebugSnapshot(snapshot: {
  nodeId: string | null;
  nodeEv: number | null;
  actionFrequencies: number[] | null;
}): void {
  if (typeof window === "undefined" || !activeSession || !activeConfig) {
    return;
  }
  window.__STUDY_DEMO_DEBUG__ = {
    exampleId: activeConfig.exampleId,
    variantId: activeConfig.variantId,
    nodeId: snapshot.nodeId,
    nodeEv: snapshot.nodeEv,
    actionFrequencies: snapshot.actionFrequencies,
    fetchedPaths: [...activeSession.fetchedPaths],
  };
}
