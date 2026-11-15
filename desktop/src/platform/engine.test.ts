import { afterEach, describe, expect, it } from "vitest";
import { engineClient } from "../engine/client";
import {
  clearFixtureIpcHandlerForTests,
  getActiveTransport,
  setNoEngineTransport,
} from "../engine/transport";
import { clearBrowserPreviewForTests } from "../preview/previewMode";
import { ensureEngine } from "./engine";

describe("ensureEngine", () => {
  afterEach(() => {
    clearBrowserPreviewForTests();
    clearFixtureIpcHandlerForTests();
    setNoEngineTransport();
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
});

describe("engineClient.setBaseUrl", () => {
  it("overrides the default packaged URL for subsequent requests", () => {
    engineClient.setBaseUrl("http://127.0.0.1:34567");
    expect(engineClient.currentBaseUrl()).toBe("http://127.0.0.1:34567");
    engineClient.setBaseUrl(null);
  });
});
