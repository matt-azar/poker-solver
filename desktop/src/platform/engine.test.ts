import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearBrowserDemoForTests } from "../demo/demoMode";
import { engineClient } from "../engine/client";
import {
  clearFixtureIpcHandlerForTests,
  getActiveTransport,
  setNoEngineTransport,
} from "../engine/transport";
import { clearBrowserPreviewForTests } from "../preview/previewMode";
import { clearBrowserRiverBetaForTests } from "../river-beta/riverBetaMode";
import { ensureEngine } from "./engine";

function stubDemoFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const path = url.replace(/^https?:\/\/[^/]+/, "").replace(/^\//, "");
      // /demo/... → desktop/public/demo/...
      const file = resolve(process.cwd(), "public", path);
      try {
        const body = readFileSync(file, "utf8");
        return new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch {
        return new Response(`missing ${file}`, { status: 404 });
      }
    }),
  );
}

describe("ensureEngine", () => {
  afterEach(() => {
    clearBrowserDemoForTests();
    clearBrowserRiverBetaForTests();
    clearBrowserPreviewForTests();
    clearFixtureIpcHandlerForTests();
    setNoEngineTransport();
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", "/");
  });

  it("no-ops successfully outside Tauri (browser / vitest)", async () => {
    const result = await ensureEngine();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toMatch(/Tauri shell/i);
      expect(result.transport.kind).toBe("no-engine");
    }
  });

  it("installs recorded fixture IPC for ?preview=node-locking", async () => {
    window.history.replaceState({}, "", "/?preview=node-locking");
    const result = await ensureEngine();
    expect(result.ok).toBe(true);
    expect(getActiveTransport().kind).toBe("ipc");
    expect(getActiveTransport().kind === "ipc" && getActiveTransport().sidecar).toBe(
      "recorded-fixture",
    );
  });

  it("installs precomputed demo IPC for ?demo=flop-explore", async () => {
    stubDemoFetch();
    window.history.replaceState({}, "", "/?demo=flop-explore");
    const result = await ensureEngine();
    expect(result.ok).toBe(true);
    expect(getActiveTransport().kind).toBe("ipc");
    expect(getActiveTransport().kind === "ipc" && getActiveTransport().sidecar).toBe(
      "precomputed-pack",
    );
  });

  it("installs river-beta IPC proxy for ?river-beta=1", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method || "GET").toUpperCase();
        if (url.includes("/health")) {
          return new Response(
            JSON.stringify({
              ok: true,
              service: "river-beta",
              active_sessions: 0,
              max_concurrent_sessions: 4,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/v1/bounds")) {
          return new Response(
            JSON.stringify({
              ok: true,
              max_iterations: 200,
              max_time_limit_sec: 30,
              summary: "river-only · ≤200 iters",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/v1/sessions") && method === "POST") {
          return new Response(
            JSON.stringify({
              ok: true,
              session: {
                session_id: "rb-test",
                idle_remaining_sec: 300,
                metrics: { peak_rss_bytes: 1 },
              },
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "X-River-Beta-Session": "rb-test",
              },
            },
          );
        }
        if (url.includes("/solve")) {
          return new Response(
            JSON.stringify({
              ok: true,
              begin: { ok: true },
              solve: { ok: true },
              metrics: { peak_rss_bytes: 1, solve_count: 1 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/ipc")) {
          return new Response(
            JSON.stringify({
              ok: true,
              envelope: {
                v: 2,
                kind: "reply",
                op: "status",
                ok: true,
                body: { running: false },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/sessions/me") && method === "GET") {
          return new Response(
            JSON.stringify({
              ok: true,
              session: {
                session_id: "rb-test",
                idle_remaining_sec: 280,
                metrics: { peak_rss_bytes: 1 },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("nope", { status: 404 });
      }),
    );
    window.history.replaceState({}, "", "/?river-beta=1");
    const result = await ensureEngine();
    expect(result.ok).toBe(true);
    expect(getActiveTransport().kind).toBe("ipc");
    expect(
      getActiveTransport().kind === "ipc" && getActiveTransport().sidecar,
    ).toBe("river-beta-service");
  });
});

describe("engineClient.setBaseUrl", () => {
  it("overrides the default packaged URL for subsequent requests", () => {
    engineClient.setBaseUrl("http://127.0.0.1:34567");
    expect(engineClient.currentBaseUrl()).toBe("http://127.0.0.1:34567");
    engineClient.setBaseUrl(null);
  });
});
