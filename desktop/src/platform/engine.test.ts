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
});

describe("engineClient.setBaseUrl", () => {
  it("overrides the default packaged URL for subsequent requests", () => {
    engineClient.setBaseUrl("http://127.0.0.1:34567");
    expect(engineClient.currentBaseUrl()).toBe("http://127.0.0.1:34567");
    engineClient.setBaseUrl(null);
  });
});
