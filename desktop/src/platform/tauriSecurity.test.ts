import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const tauriConfPath = resolve(here, "../../src-tauri/tauri.conf.json");
const capabilitiesPath = resolve(here, "../../src-tauri/capabilities/default.json");

describe("packaged Study Tauri security config", () => {
  it("sets a non-null production CSP covering loopback explorer and OpenAI", () => {
    const config = JSON.parse(readFileSync(tauriConfPath, "utf8")) as {
      app: {
        security: {
          csp: Record<string, string> | null;
          devCsp?: unknown;
        };
      };
    };
    const csp = config.app.security.csp;
    expect(csp).not.toBeNull();
    expect(csp).toBeTypeOf("object");
    const connect = csp!["connect-src"];
    expect(connect).toContain("ipc:");
    expect(connect).toContain("http://ipc.localhost");
    expect(connect).toContain("http://127.0.0.1:*");
    expect(connect).toContain("https://api.openai.com");
    expect(config.app.security.devCsp).toBeNull();
  });

  it("keeps sidecar spawn and drops unused shell execute grants", () => {
    const caps = JSON.parse(readFileSync(capabilitiesPath, "utf8")) as {
      permissions: Array<string | { identifier: string }>;
    };
    const identifiers = caps.permissions.map((entry) =>
      typeof entry === "string" ? entry : entry.identifier,
    );
    expect(identifiers).toContain("shell:allow-spawn");
    expect(identifiers).not.toContain("shell:allow-execute");
  });
});
