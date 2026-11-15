import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearFixtureIpcHandlerForTests,
  hasFixtureIpcHandler,
  setNoEngineTransport,
} from "../engine/transport";
import {
  clearBrowserDemoForTests,
  formatDemoSearch,
  installBrowserDemoTransport,
  isBrowserDemoMode,
  parseDemoSearch,
} from "./demoMode";

function stubDemoFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const path = url.replace(/^https?:\/\/[^/]+/, "").replace(/^\//, "");
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

describe("demoMode URL helpers", () => {
  it("parses demo / variant / node query params", () => {
    expect(parseDemoSearch("?demo=flop-explore&node=p1.t-1.r-1")).toEqual({
      exampleId: "flop-explore",
      variantId: null,
      nodeId: "p1.t-1.r-1",
    });
    expect(
      parseDemoSearch("?demo=river-lock&variant=oop-always-check"),
    ).toEqual({
      exampleId: "river-lock",
      variantId: "oop-always-check",
      nodeId: null,
    });
  });

  it("formats shareable search without default baseline variant", () => {
    expect(
      formatDemoSearch({
        exampleId: "flop-explore",
        variantId: "baseline",
        defaultVariant: "baseline",
      }),
    ).toBe("?demo=flop-explore");
    expect(
      formatDemoSearch({
        exampleId: "river-lock",
        variantId: "oop-always-check",
        nodeId: "p0.t-1.r-1",
        defaultVariant: "baseline",
      }),
    ).toBe("?demo=river-lock&variant=oop-always-check&node=p0.t-1.r-1");
  });

  it("detects ?demo= as browser demo mode", () => {
    expect(isBrowserDemoMode("?demo=flop-explore")).toBe(true);
    expect(isBrowserDemoMode("?preview=node-locking")).toBe(false);
  });
});

describe("installBrowserDemoTransport", () => {
  afterEach(() => {
    clearBrowserDemoForTests();
    clearFixtureIpcHandlerForTests();
    setNoEngineTransport();
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", "/");
  });

  it("arms precomputed fixture IPC for ?demo=flop-explore", async () => {
    stubDemoFetch();
    window.history.replaceState({}, "", "/?demo=flop-explore");
    const boot = await installBrowserDemoTransport();
    expect(boot?.exampleId).toBe("flop-explore");
    expect(boot?.variantId).toBe("baseline");
    expect(hasFixtureIpcHandler()).toBe(true);
  });
});
