import { describe, expect, it } from "vitest";
import { ensureEngine } from "./engine";

describe("ensureEngine", () => {
  it("no-ops successfully outside Tauri (browser / vitest)", async () => {
    const result = await ensureEngine();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toMatch(/browser/i);
    }
  });
});
