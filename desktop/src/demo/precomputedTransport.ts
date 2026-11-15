/**
 * Precomputed public-demo IPC handler.
 *
 * Serves protocol-2 replies by lazily fetching split packs under `/demo/…`
 * (same layout as `scripts/public-demo/export_solutions.py`). Live train ops
 * are refused — this path is browse-only.
 */
import type { FixtureIpcHandler, IpcRequestEnvelope } from "../engine/transport";
import { SolverIpcError } from "../engine/transport";
import type { DemoCatalog, DemoExpected, DemoManifest } from "./types";

const DEMO_ROOT = "/demo";

/**
 * Prefix a site-absolute path with Vite `BASE_URL` so GitHub Pages project
 * hosting (`/poker-solver/`) and local `/` preview share one fetch path.
 */
export function withBase(path: string): string {
  const base = import.meta.env.BASE_URL || "/";
  const baseNorm = base.endsWith("/") ? base.slice(0, -1) : base;
  const pathNorm = path.startsWith("/") ? path : `/${path}`;
  return `${baseNorm}${pathNorm}`;
}

export type PrecomputedSession = {
  exampleId: string;
  variantId: string;
  packBase: string;
  catalog: DemoCatalog;
  manifest: DemoManifest;
  /** Absolute paths fetched during this session (for Playwright / size gates). */
  fetchedPaths: string[];
  handler: FixtureIpcHandler;
  setVariant: (variantId: string) => Promise<void>;
  getExpected: () => Promise<DemoExpected>;
  getStatusGeneration: () => number;
};

function envelope(op: string, body: unknown, requestId: string): IpcRequestEnvelope {
  return {
    v: 2,
    kind: "reply",
    request_id: requestId,
    job_id: null,
    op,
    ok: true,
    error_code: null,
    error_message: null,
    body,
  };
}

function failEnvelope(
  op: string,
  requestId: string,
  code: string,
  message: string,
): IpcRequestEnvelope {
  return {
    v: 2,
    kind: "reply",
    request_id: requestId,
    job_id: null,
    op,
    ok: false,
    error_code: code,
    error_message: message,
    body: null,
  };
}

function nodeFileName(nodeId: string): string {
  return `${nodeId.replace(/[^\w.\-]+/g, "_")}.json`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

async function fetchJson<T>(
  path: string,
  fetched: string[],
  opts?: { optional?: boolean },
): Promise<T | null> {
  const sitePath = path.startsWith("/") ? path : `/${path}`;
  const url = withBase(sitePath);
  fetched.push(url);
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) {
    if (opts?.optional && (res.status === 404 || res.status === 403)) {
      return null;
    }
    throw new SolverIpcError({
      class: "engine_rejection",
      message: `precomputed fetch failed ${res.status}: ${url}`,
      errorCode: "not_found",
      op: "fetch",
    });
  }
  return (await res.json()) as T;
}

export async function loadDemoCatalog(
  fetched: string[] = [],
): Promise<DemoCatalog> {
  const catalog = await fetchJson<DemoCatalog>(
    `${DEMO_ROOT}/catalog.json`,
    fetched,
  );
  if (!catalog) {
    throw new Error("demo catalog.json missing");
  }
  return catalog;
}

export async function loadDemoManifest(
  exampleId: string,
  fetched: string[] = [],
): Promise<DemoManifest> {
  const manifest = await fetchJson<DemoManifest>(
    `${DEMO_ROOT}/${encodeURIComponent(exampleId)}/manifest.json`,
    fetched,
  );
  if (!manifest) {
    throw new Error(`demo manifest missing for ${exampleId}`);
  }
  return manifest;
}

function resolvePackBase(exampleId: string, variantId: string, manifest: DemoManifest): string {
  const variant =
    manifest.variants.find((entry) => entry.id === variantId) ??
    manifest.variants.find((entry) => entry.id === manifest.default_variant) ??
    manifest.variants[0];
  if (!variant) {
    throw new Error(`demo manifest ${exampleId} has no variants`);
  }
  return `${DEMO_ROOT}/${encodeURIComponent(exampleId)}/${encodeURIComponent(variant.pack)}`;
}

/**
 * Build a FixtureIpcHandler that answers Study browse/inspect ops from static packs.
 */
export async function createPrecomputedSession(opts: {
  exampleId: string;
  variantId?: string | null;
  catalog?: DemoCatalog;
}): Promise<PrecomputedSession> {
  const fetchedPaths: string[] = [];
  const catalog = opts.catalog ?? (await loadDemoCatalog(fetchedPaths));
  const exampleId =
    opts.exampleId ||
    catalog.default_example ||
    catalog.examples[0]?.id ||
    "flop-explore";
  const manifest = await loadDemoManifest(exampleId, fetchedPaths);
  let variantId =
    (opts.variantId && opts.variantId.trim()) ||
    manifest.default_variant ||
    manifest.variants[0]?.id ||
    "baseline";
  let packBase = resolvePackBase(exampleId, variantId, manifest);

  // Cache per-variant JSON so switching presets does not refetch the same file.
  const cache = new Map<string, unknown>();
  let requestSeq = 0;
  let statusGenerationBump = 0;

  async function loadPackJson<T>(
    rel: string,
    opts?: { optional?: boolean },
  ): Promise<T | null> {
    const path = `${packBase}/${rel}`;
    if (cache.has(path)) {
      return cache.get(path) as T;
    }
    const data = await fetchJson<T>(path, fetchedPaths, opts);
    if (data != null) {
      cache.set(path, data);
    }
    return data;
  }

  async function statusBody(): Promise<Record<string, unknown>> {
    const status = (await loadPackJson<Record<string, unknown>>("status.json"))!;
    const gen =
      (typeof status.status_generation === "number"
        ? status.status_generation
        : 1) + statusGenerationBump;
    return { ...status, status_generation: gen };
  }

  /**
   * Host packs store decision children as string[] parallel to `actions`.
   * Study already accepts that; also expand to labeled objects so ActionNav
   * frequency tooltips stay useful when present.
   */
  function normalizeNode(node: Record<string, unknown>): Record<string, unknown> {
    const actions = Array.isArray(node.actions)
      ? (node.actions as unknown[]).map(String)
      : [];
    const children = node.children;
    if (
      Array.isArray(children) &&
      children.length > 0 &&
      children.every((c) => typeof c === "string")
    ) {
      const freqs = Array.isArray(node.action_frequencies)
        ? (node.action_frequencies as number[])
        : [];
      node = {
        ...node,
        children: (children as string[]).map((nodeId, index) => ({
          action: actions[index] ?? `action-${index}`,
          label: actions[index] ?? `action-${index}`,
          node_id: nodeId,
          frequency: freqs[index] ?? null,
        })),
      };
    }
    return node;
  }

  const handler: FixtureIpcHandler = async (op, body) => {
    requestSeq += 1;
    const requestId = `demo-${requestSeq}`;

    switch (op) {
      case "status":
        return envelope(op, await statusBody(), requestId);
      case "node": {
        const nodeId =
          (asRecord(body)?.node_id as string | undefined) ||
          manifest.root_node_id ||
          "p0.t-1.r-1";
        const node = await loadPackJson<Record<string, unknown>>(
          `nodes/${nodeFileName(nodeId)}`,
        );
        if (!node) {
          return failEnvelope(op, requestId, "not_found", `Unknown node ${nodeId}`);
        }
        return envelope(op, normalizeNode(node), requestId);
      }
      case "values": {
        const nodeId =
          (asRecord(body)?.node_id as string | undefined) ||
          manifest.root_node_id ||
          "p0.t-1.r-1";
        // Export writes values only for decision nodes (chance has no EV pack).
        const values = await loadPackJson<Record<string, unknown>>(
          `values/${nodeFileName(nodeId)}`,
          { optional: true },
        );
        if (!values) {
          return envelope(
            op,
            {
              pending: false,
              node_id: nodeId,
              error: "No precomputed action EVs for this node (chance/terminal).",
              node_ev_defined: false,
            },
            requestId,
          );
        }
        return envelope(op, values, requestId);
      }
      case "equity": {
        const nodeId =
          (asRecord(body)?.node_id as string | undefined) ||
          manifest.root_node_id ||
          "p0.t-1.r-1";
        const equity = await loadPackJson<Record<string, unknown>>(
          `equity/${nodeFileName(nodeId)}`,
          { optional: true },
        );
        if (!equity) {
          return envelope(
            op,
            {
              pending: false,
              node_id: nodeId,
              defined: false,
              error: "No precomputed equity for this node (chance/terminal).",
            },
            requestId,
          );
        }
        return envelope(op, equity, requestId);
      }
      case "list_locks":
        return envelope(
          op,
          (await loadPackJson("locks.json", { optional: true })) ?? { locks: [] },
          requestId,
        );
      case "list_strategy_edits":
        return envelope(op, { edits: [], persisted: false }, requestId);
      case "categories":
        return envelope(
          op,
          {
            node_id: manifest.root_node_id,
            categories: [],
            policy_revision: 0,
          },
          requestId,
        );
      case "get_config":
        return envelope(
          op,
          {
            config_text: `# precomputed ${exampleId}/${variantId}\n`,
            board: manifest.board ?? null,
          },
          requestId,
        );
      case "begin_config":
      case "solve":
      case "pause":
      case "cancel":
      case "put_lock":
      case "delete_lock":
      case "resolve_locked":
      case "tree_preview":
      case "plan_memory":
      case "save":
      case "open":
        return failEnvelope(
          op,
          requestId,
          "precomputed_readonly",
          "Public demo is precomputed — live solving requires the Windows app.",
        );
      default:
        return envelope(op, {}, requestId);
    }
  };

  const session: PrecomputedSession = {
    exampleId,
    variantId,
    packBase,
    catalog,
    manifest,
    fetchedPaths,
    handler,
    async setVariant(nextVariantId: string) {
      if (nextVariantId === variantId) {
        return;
      }
      variantId = nextVariantId;
      packBase = resolvePackBase(exampleId, variantId, manifest);
      session.variantId = variantId;
      session.packBase = packBase;
      statusGenerationBump += 1;
    },
    async getExpected() {
      const expected = await loadPackJson<DemoExpected>("expected.json");
      if (!expected) {
        throw new Error(`expected.json missing under ${packBase}`);
      }
      return expected;
    },
    getStatusGeneration: () => statusGenerationBump,
  };

  return session;
}
