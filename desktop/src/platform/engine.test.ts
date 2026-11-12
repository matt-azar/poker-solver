import { describe, expect, it } from "vitest";
import { engineClient } from "../engine/client";
import { ensureEngine } from "./engine";

describe("ensureEngine", () => {
  it("no-ops successfully outside Tauri (browser / vitest)", async () => {
    const result = await ensureEngine();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toMatch(/browser/i);
      expect(result.endpoint).toBeUndefined();
      expect(result.transport.kind).toBe("http-fallback");
    }
  });
});

describe("engineClient.setBaseUrl", () => {
  it("overrides the default packaged URL for subsequent requests", () => {
    engineClient.setBaseUrl("http://127.0.0.1:34567");
    expect(engineClient.currentBaseUrl()).toBe("http://127.0.0.1:34567");
    engineClient.setBaseUrl(null);
  });
});
