import { describe, expect, it, vi } from "vitest";
import { createPrecomputedSession } from "./precomputedTransport";

const catalog = {
  version: 1,
  label: "Precomputed",
  engine_build_sha: "test",
  download_windows_url: "https://example.test/setup.exe",
  default_example: "flop-explore",
  examples: [
    {
      id: "flop-explore",
      title: "Flop explore",
      street: "flop",
      description: "test",
      path: "flop-explore/manifest.json",
    },
  ],
};

const manifest = {
  id: "flop-explore",
  title: "Flop explore",
  label: "Precomputed",
  street: "flop",
  description: "test",
  root_node_id: "p0.t-1.r-1",
  default_variant: "baseline",
  variants: [
    {
      id: "baseline",
      title: "Baseline",
      description: "base",
      pack: "baseline",
    },
  ],
};

const rootNode = {
  node_id: "p0.t-1.r-1",
  actions: ["Check", "Bet 50"],
  action_frequencies: [0.62, 0.38],
  children: [{ action: "Check", node_id: "p1.t-1.r-1" }],
};

describe("createPrecomputedSession", () => {
  it("lazy-fetches only requested node packs", async () => {
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        fetched.push(url);
        if (url.endsWith("/catalog.json")) {
          return new Response(JSON.stringify(catalog), { status: 200 });
        }
        if (url.endsWith("/manifest.json")) {
          return new Response(JSON.stringify(manifest), { status: 200 });
        }
        if (url.includes("/nodes/p0.t-1.r-1.json")) {
          return new Response(JSON.stringify(rootNode), { status: 200 });
        }
        if (url.endsWith("/status.json")) {
          return new Response(
            JSON.stringify({
              solution_id: "s1",
              root_node_id: "p0.t-1.r-1",
              running: false,
              status_generation: 1,
              policy_revision: 1,
            }),
            { status: 200 },
          );
        }
        return new Response("missing", { status: 404 });
      }),
    );

    const session = await createPrecomputedSession({
      exampleId: "flop-explore",
      catalog: catalog as never,
    });
    const status = await session.handler("status", null);
    expect(status.ok).toBe(true);
    const node = await session.handler("node", { node_id: "p0.t-1.r-1" });
    expect((node.body as { action_frequencies: number[] }).action_frequencies).toEqual([
      0.62, 0.38,
    ]);
    expect(fetched.some((u) => u.includes("p1.t-1.r-1"))).toBe(false);

    const refused = await session.handler("solve", { iterations: 1 }, "job");
    expect(refused.ok).toBe(false);
    expect(refused.error_code).toBe("precomputed_readonly");

    vi.unstubAllGlobals();
  });
});
